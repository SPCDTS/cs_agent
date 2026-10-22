/**
 * codex 后端：常驻 app-server 适配器（设计 §5、§14 第 3 步），实现 ThreadHost 的 ThreadAdapter。
 * - 线程：会话键 → codex 线程（CodexRunner 的映射与轮换）；进程代中首次使用时 thread/start 或 thread/resume，
 *   同时为该会话签发线程令牌，写入 im / qq_context / image_gen 的线程级 MCP 环境；重启后令牌作废、按需重新加载。
 * - 回合簿记：线程上服务端的每个回合恰好判定一次种类，之后不再改判——
 *   user（本适配器开的：turn/start 响应返回的 id；或开轮结果不确定时，首条 userMessage 的 clientId 等于本输入键），
 *   wake（服务端自己开的，子 agent 完成唤醒），compaction（压缩回合），suppressed（停止后被中止的唤醒）。
 *   开轮请求在途期间、压缩期间服务端开的回合先待判定，不交给宿主；开轮在途期间的服务端回合不会判为 user。
 *   每个回合的结束（turn/completed、掉线 turnLost）都会处理：清掉该回合的簿记；user / wake 的结束交给宿主；
 *   compaction / suppressed 的结束不交给宿主，除非宿主为排在它后面而接管了它（开轮让位），此时按完成交给宿主以放行排队输入。
 * - 开一轮：turn/start（effort、model、clientUserMessageId=输入键），回合 id 为 `codex:<codex 回合 id>`。
 *   线程上有非本适配器的回合进行中时不开轮，返回 backendTurnId 让宿主排在它后面。
 *   开轮结果不确定（请求已发出、连接断开或超时）：不重发这条输入；按 clientId 认领到回合就用它，否则以 lost 结束（§5.4）。
 * - 插话 turn/steer（no_active_turn、not_steerable 都回报 no_active_turn，宿主改为排队）。
 * - 结束：turn/completed（completed → completed；interrupted、failed 或此前有不再重试的 error → failed）、
 *   进程掉线 → lost（宿主发 §8.1 的中断提示）。不设单轮时限，停滞由宿主看门狗按事件判定（条目、子 agent 活动都算）。
 * - 工具调用（§5.3、§7.3）：resolveCall 只认服务端记录的归属（callId 对应的 mcpToolCall 条目所在线程与回合），
 *   该回合须是宿主当前回合；子 agent 线程的调用、过期回合的调用一律拒绝。
 * - 停止：中止主回合与运行中的子 agent 回合，之后 STOP_WAKE_MS 内（直到下一次开轮）服务端开的唤醒回合判为 suppressed 并中止（§8.2）。
 * - 忙：有进行中的回合、子 agent 线程仍在运行或正在压缩时，后端切换须等待（busy）。
 * - 生图：image_gen 等待超时的任务留在会话目录的清单里，回合结束时按会话串行补收，每个任务以稳定键发一条系统消息
 *   （重试不重发），只移除处理过的任务（收取期间新追加的留给下一次）。
 * - 压缩：面板"压缩"在会话空闲时经同一 app-server 发 thread/compact/start；压缩期间服务端开的回合按首个条目判定
 *   （contextCompaction → compaction；其他 → wake；没有条目就结束 → compaction）。压缩锁持有到压缩回合结束（或掉线、超时）。
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { classifyFailure } from "../../shared/errors.js";
import { redactText } from "../../shared/redact.js";
import { trace } from "../../shared/trace.js";
import { log } from "../../shared/log.js";
import { isOwner, type OwnerIds } from "../../shared/owners.js";
import { isReasoningEffort, type CodexRunner } from "../codex/runner.js";
import { RpcError } from "../codex/app-server/rpc.js";
import { AppServerUnavailableError } from "../codex/app-server/supervisor.js";
import { ThreadNotLoadedError, type ItemEvent, type ThreadItem, type TurnCompletedEvent, type UserInput } from "../codex/app-server/client.js";
import type { ReasoningEffort, TicketSettings } from "./types.js";
import { collectNewImages } from "../../media/gen/image-collect.js";
import { attachmentDirs } from "../../media/attach-paths.js";
import { imageTimeoutMs } from "../../media/gen/image-options.js";
import { pendingCallDir, PendingImageMarkerError, quarantinePendingImages, readPendingImages, removePendingImages } from "../../media/gen/image-pending.js";
import { recoverRemoteUploads, UnknownJobError, type ImageBackend } from "../../media/gen/image-gen.js";
import { ingestImageEvents } from "../../media/gen/events.js";
import { observeImages } from "../../media/gen/observed.js";
import type { CallBinding, CallMeta, ThreadTokens } from "../../context/media-recall-server.js";
import type { HostCallbacks, InputRef, StartTurnResult, ThreadAdapter, ThreadKey, TurnContext, TurnOutcome } from "../host/types.js";
import type { PiTurns } from "./pi.js";
import type { SendService } from "../send-service.js";
import { IMAGE_SUCCESS_REPLY } from "../replies.js";

export interface CodexBackendOptions {
  runner: Pick<CodexRunner, "client" | "supervisor" | "openThread" | "rotationDue" | "threadId" | "resetThread" | "recordTurnUsage" | "recordCompaction" | "workspaceOf">;
  tokens: Pick<ThreadTokens, "issue" | "revoke">;
  /** ${DATA_DIR}/images：会话图片目录的根（须与 image_gen MCP 的 ${DATA_DIR}/images 一致） */
  imagesDir: string;
  /** CODEX_REASONING_EFFORT；不在允许列表内时不传（沿用 config.toml）。函数形式每回合现读（运行时设置）。 */
  reasoningEffort?: string | (() => string | undefined);
  turns: PiTurns;
  owners?: OwnerIds | (() => OwnerIds);
  /** 补收图片的发送（系统消息）；未接入时只记日志 */
  sendService?: Pick<SendService, "system">;
  imageBackend?: Pick<ImageBackend, "name" | "submit" | "collect" | "reconcile" | "clearReferences">;
  imageTimeoutCapMs?: number;
  /** 工具调用等待回合事件（条目、宿主确认开轮）的上限，默认 5 秒 */
  callWaitMs?: number;
  /** 压缩等待上限，默认 5 分钟 */
  compactTimeoutMs?: number;
}

/** 回合种类：判定一次，之后不再改判。 */
type TurnKind = "user" | "wake" | "compaction" | "suppressed";

/** 线程上一个进行中（或待判定）的服务端回合 */
interface TurnRec {
  key: ThreadKey;
  threadId: string;
  codexTurnId: string;
  /** undefined：待判定（开轮请求在途、压缩期间） */
  kind?: TurnKind;
  startedAt: number;
  model?: string;
  /** 首条 userMessage 条目的 clientId（= 开轮时的 clientUserMessageId） */
  clientId?: string;
  /** 宿主跟踪这个回合：user、wake，或宿主开轮让位接管的 compaction / suppressed */
  hostVisible: boolean;
  /** 判定前已结束：判定后立即按此结果处理 */
  ended?: TurnOutcome;
  /** 判定前到达的条目（观测用）：判为 user / wake 时补记，其他种类丢弃 */
  buffered: { phase: "started" | "completed"; item: ThreadItem }[];
}

interface Compaction { done(error?: Error): void }

const hostTurnId = (codexTurnId: string) => "codex:" + codexTurnId;
/** 停止后抑制子 agent 唤醒的时长 */
export const STOP_WAKE_MS = 60_000;
/** 服务端明确拒绝或请求根本没有发出：开轮可以安全重试 */
const definiteFailure = (error: unknown) => error instanceof RpcError || error instanceof ThreadNotLoadedError || error instanceof AppServerUnavailableError;
const TERMINAL_CHILD = /complet|error|fail|interrupt|clos|shut|cancel|abort/i;

export class CodexBackend implements ThreadAdapter {
  readonly name = "codex" as const;
  private host?: HostCallbacks;
  /** 本进程代已加载的会话线程 */
  private readonly threadIds = new Map<ThreadKey, string>();
  private readonly keys = new Map<string, ThreadKey>();
  /** 进行中（含待判定）的回合：codex 回合 id → 簿记；结束即删除 */
  private readonly turnRecs = new Map<string, TurnRec>();
  /** 最近结束回合的墓碑（codex 回合 id → 种类与结果，有界）：结束后到达的同 id 事件或开轮响应不再建立进行中的簿记 */
  private readonly finished = new Map<string, { kind: TurnKind; outcome: TurnOutcome }>();
  /** 最近结束的 user / wake 回合结果（宿主放弃回合时结束事件可能还排在宿主队列里），按宿主回合 id */
  private readonly ended = new Map<string, TurnOutcome>();
  /** codex 回合 → 不再重试的 error（turn/completed 时并入结果） */
  private readonly failures = new Map<string, string>();
  /** mcpToolCall 条目 id（= MCP _meta.callId）→ 所在线程与 codex 回合 */
  private readonly calls = new Map<string, { threadId: string; turnId: string }>();
  /** 会话 → 仍在运行的子 agent 线程 → 其进行中的回合（未知为 undefined） */
  private readonly children = new Map<ThreadKey, Map<string, string | undefined>>();
  private readonly compactions = new Map<string, Compaction>();
  /** 正在 turn/start 的线程 → 本输入键与期间服务端开出的回合 */
  private readonly starting = new Map<string, { clientId: string | undefined; observed: string[] }>();
  /** 停止后到期前，服务端开的唤醒回合判为 suppressed */
  private readonly stopped = new Map<ThreadKey, number>();
  /** 每个会话的加载、开轮、压缩、重置串行 */
  private readonly chains = new Map<ThreadKey, Promise<unknown>>();
  /** 每个会话的补收图片串行 */
  private readonly imageChains = new Map<ThreadKey, Promise<unknown>>();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly opts: CodexBackendOptions) {
    const initial = typeof opts.reasoningEffort === "function" ? opts.reasoningEffort() : opts.reasoningEffort;
    if (initial && !isReasoningEffort(initial)) {
      log.warn("CODEX_REASONING_EFFORT not in the allowed list; per-turn override omitted", { value: initial });
    }
    const client = opts.runner.client;
    client.on("turnStarted", e => this.onTurnStarted(e.threadId, e.turnId, e.initiatedBy));
    client.on("turnCompleted", e => this.onTurnCompleted(e));
    client.on("turnLost", e => this.endTurn(e.threadId, e.turnId, { status: "lost", error: "codex app-server 掉线：" + e.reason }));
    client.on("turnError", e => {
      if (!e.turnId) return;
      if (this.keys.has(e.threadId)) trace.event("turn:" + hostTurnId(e.turnId), "model_error", { status: "failed", detail: { backend: "codex", will_retry: e.willRetry,
        failure: classifyFailure(e.error?.message, "codex") } });
      if (!e.willRetry) this.failures.set(e.turnId, "codex 回合出错");
    });
    client.on("item", e => this.onItem(e));
    client.on("subAgent", e => this.onChild(e.parentThreadId, e.agentThreadId, !TERMINAL_CHILD.test(e.kind)));
    client.on("childActivity", e => {
      const alive = e.method === "turn/started" ? true : e.method === "turn/completed" ? false : undefined;
      this.onChild(e.parentThreadId, e.agentThreadId, alive, e.turnId);
    });
    // 进程掉线：client 已对各线程的活动回合发出 turnLost；其余仍在簿记里的回合同样按丢失结束（不留悬挂状态）；
    // 线程、子 agent 与压缩随进程丢失，令牌作废，重新加载时重新签发。
    opts.runner.supervisor.on("down", () => {
      for (const rec of [...this.turnRecs.values()]) if (!rec.ended) this.endTurn(rec.threadId, rec.codexTurnId, { status: "lost", error: "codex app-server 掉线" });
      for (const key of this.threadIds.keys()) opts.tokens.revoke(key);
      this.threadIds.clear();
      this.keys.clear();
      this.children.clear();
      for (const compaction of [...this.compactions.values()]) compaction.done(new Error("codex app-server 掉线"));
    });
  }

  attach(host: HostCallbacks): void { this.host = host; }

  /** 本回合的推理强度（运行时设置可在两回合之间修改）。 */
  private get effort(): ReasoningEffort | undefined {
    const value = typeof this.opts.reasoningEffort === "function" ? this.opts.reasoningEffort() : this.opts.reasoningEffort;
    return isReasoningEffort(value) ? value : undefined;
  }

  private owners(): OwnerIds { return typeof this.opts.owners === "function" ? this.opts.owners() : this.opts.owners; }

  // ───────────── 线程 ─────────────

  /** 会话线程已在当前进程代加载则直接用（空闲且到期时轮换）；否则签发线程令牌并加载。须在会话串行内调用。 */
  private async ensureThread(threadKey: ThreadKey, model: string | undefined): Promise<string> {
    const loaded = this.threadIds.get(threadKey);
    const snapshot = loaded ? this.opts.runner.client.thread(loaded) : undefined;
    if (loaded && snapshot?.loaded) {
      if (this.threadBusy(threadKey, loaded) || !await this.opts.runner.rotationDue(threadKey)) return loaded;
      // 等待检查期间可能来了唤醒回合或子 agent：只在仍然空闲时轮换
      if (this.threadBusy(threadKey, loaded)) return loaded;
      this.unload(threadKey);
    }
    const token = this.opts.tokens.issue(threadKey);
    const threadId = await this.opts.runner.openThread(threadKey, { model,
      mcpEnv: { im: { IM_TOKEN: token }, qq_context: { QQ_RECALL_TOKEN: token }, image_gen: { IMAGE_GEN_TOKEN: token } } });
    this.threadIds.set(threadKey, threadId);
    this.keys.set(threadId, threadKey);
    return threadId;
  }

  /** 线程上进行中（含待判定）的回合，按开始先后。 */
  private liveTurns(threadId: string): TurnRec[] {
    return [...this.turnRecs.values()].filter(rec => rec.threadId === threadId && !rec.ended);
  }

  /** 会话当前的 user / wake 回合（宿主跟踪的那一个）。 */
  private hostTurn(threadKey: ThreadKey): TurnRec | undefined {
    return [...this.turnRecs.values()].filter(rec => rec.key === threadKey && !rec.ended && (rec.kind === "user" || rec.kind === "wake")).at(-1);
  }

  /** 线程上有进行中的回合（任何种类）或运行中的子 agent。 */
  private threadBusy(threadKey: ThreadKey, threadId: string): boolean {
    return this.liveTurns(threadId).length > 0 || !!this.children.get(threadKey)?.size || !!this.opts.runner.client.thread(threadId)?.activeTurnId;
  }

  /** 不再使用会话当前加载的线程（轮换、重置、线程未加载）：令牌作废。 */
  private unload(threadKey: ThreadKey): void {
    const threadId = this.threadIds.get(threadKey);
    this.threadIds.delete(threadKey);
    this.opts.tokens.revoke(threadKey);
    if (threadId) { this.keys.delete(threadId); this.opts.runner.client.forgetThread(threadId); }
    this.children.delete(threadKey);
  }

  // ───────────── ThreadAdapter ─────────────

  async startTurn(threadKey: ThreadKey, inputs: readonly InputRef[], turn: TurnContext, settings?: TicketSettings): Promise<StartTurnResult> {
    // 先渲染：输入缺失等错误在开轮时就抛出，宿主按开轮失败处理。
    const rendered = await this.opts.turns.render(this.opts.turns.records(inputs));
    const model = settings?.codexModel;
    const effort = settings ? settings.codexReasoningEffort : this.effort;
    // 宿主每轮只送一条输入；其输入键作为 clientUserMessageId（开轮结果不确定时据此认领回合）
    const clientId = inputs[0]?.inboundKey;
    const input: UserInput[] = [{ type: "text", text: rendered.text }];
    const options = { ...(effort ? { effort } : {}), ...(model ? { model } : {}), ...(clientId ? { clientUserMessageId: clientId } : {}) };
    return this.serial(threadKey, async () => {
      // 用户（或定时）开了新一轮：停止后的唤醒抑制到此为止
      this.stopped.delete(threadKey);
      let threadId = await this.ensureThread(threadKey, model);
      const blocking = this.blocking(threadKey, threadId);
      if (blocking) return blocking;
      const startedAt = Date.now();
      let started = await this.submit(threadId, clientId, input, options);
      if (started.error instanceof ThreadNotLoadedError) {
        this.releaseObserved(started.observed);
        this.unload(threadKey);
        threadId = await this.ensureThread(threadKey, model);
        started = await this.submit(threadId, clientId, input, options);
      }
      let codexTurnId = started.turnId;
      if (!codexTurnId) {
        if (definiteFailure(started.error)) { this.releaseObserved(started.observed); throw started.error; }
        // 结果不确定：只按 clientId 认领（首条 userMessage 带本输入键），不按时机
        codexTurnId = clientId ? started.observed.find(id => this.turnRecs.get(id)?.clientId === clientId) : undefined;
        if (!codexTurnId) {
          const turnId = "codex:unconfirmed-" + randomUUID();
          const outcome: TurnOutcome = { status: "lost", error: "codex 开轮结果未知：" + (started.error instanceof Error ? started.error.message : String(started.error)) };
          log.warn("codex turn/start result unknown; input not resubmitted", { thread: threadKey, error: outcome.error });
          this.ended.set(turnId, outcome);
          this.host?.onTurnCompleted(threadKey, turnId, outcome);
          this.releaseObserved(started.observed);
          return { turnId };
        }
        log.warn("codex turn/start result unknown; claimed turn by clientUserMessageId", { thread: threadKey, turn: codexTurnId });
      }
      const turnId = hostTurnId(codexTurnId);
      const tomb = this.finished.get(codexTurnId);
      if (tomb) {
        // 本轮在响应之前就已开始并结束：不再建立进行中的簿记；结束已交给宿主（user），否则按记下的结果补交
        if (tomb.kind !== "user") this.host?.onTurnCompleted(threadKey, turnId, tomb.outcome);
      } else {
        const rec = this.record(threadKey, threadId, codexTurnId);
        rec.startedAt = startedAt;
        if (model) rec.model = model;
        if (rec.kind === undefined) this.classify(rec, "user");
      }
      // 本轮已开出：在途期间服务端另开的回合判为 wake，但不交给宿主（否则宿主会以唤醒取代本轮）
      this.releaseObserved(started.observed.filter(id => id !== codexTurnId), false);
      trace.event("turn:" + turnId, "dispatched", { detail: { backend: "codex", thread_key: threadKey, thread_id: threadId, kind: turn.kind,
        effort: effort ?? null, inputs: inputs.map(i => i.inboundKey) } });
      trace.event("turn:" + turnId, "model_turn", { status: "started", detail: { backend: "codex", thread_key: threadKey, effort: effort ?? null } });
      return { turnId };
    });
  }

  /**
   * 线程上有非本适配器的回合进行中：不开轮，返回 backendTurnId 让宿主排在它后面。
   * compaction / suppressed / 待判定的回合宿主原本不知道：标为宿主跟踪，结束时按完成交给宿主以放行排队输入。
   */
  private blocking(threadKey: ThreadKey, threadId: string): StartTurnResult | undefined {
    const live = this.liveTurns(threadId).at(-1);
    if (live) {
      live.hostVisible = true;
      return { backendTurnId: hostTurnId(live.codexTurnId) };
    }
    const running = this.opts.runner.client.thread(threadId)?.activeTurnId;
    if (!running) return undefined;
    // 没有簿记的活动回合（不应出现）：按唤醒回合登记后让位
    const rec = this.record(threadKey, threadId, running);
    rec.hostVisible = true;
    if (rec.kind === undefined) rec.kind = "wake";
    return { backendTurnId: hostTurnId(running) };
  }

  /** 发一次 turn/start，记下期间服务端开出的回合（它们待判定，绝不判为本轮，除非 clientId 匹配）。 */
  private async submit(threadId: string, clientId: string | undefined, input: UserInput[], options: { effort?: string; model?: string; clientUserMessageId?: string }):
    Promise<{ turnId?: string; observed: string[]; error?: unknown }> {
    const record = { clientId, observed: [] as string[] };
    this.starting.set(threadId, record);
    try {
      return { turnId: await this.opts.runner.client.startTurn(threadId, input, options), observed: record.observed };
    } catch (error) {
      return { error, observed: record.observed };
    } finally {
      if (this.starting.get(threadId) === record) this.starting.delete(threadId);
    }
  }

  /**
   * 开轮在途期间服务端开出、最终不是本轮的回合：判为 wake（停止窗口内为 suppressed）。
   * toHost=false：本轮已开出，这些回合不交给宿主（结束事件照常处理，宿主按过期忽略）。
   */
  private releaseObserved(ids: readonly string[], toHost = true): void {
    for (const id of ids) {
      const rec = this.turnRecs.get(id);
      if (rec && rec.kind === undefined) this.classify(rec, this.serverKind(rec.key, rec.threadId), toHost);
    }
  }

  /** 服务端开的回合在当前状态下的种类（不在开轮、压缩期间）。 */
  private serverKind(key: ThreadKey, _threadId: string): TurnKind {
    const until = this.stopped.get(key);
    return until !== undefined && until > Date.now() ? "suppressed" : "wake";
  }

  /** 插话进当前回合；回合已结束、id 不符或当前回合不可插话时回报 no_active_turn（宿主排队）。 */
  async steer(threadKey: ThreadKey, turnId: string, input: InputRef): Promise<"ok" | "no_active_turn"> {
    const current = this.hostTurn(threadKey);
    if (current?.kind !== "user" || hostTurnId(current.codexTurnId) !== turnId) return "no_active_turn";
    const rendered = await this.opts.turns.render(this.opts.turns.records([input]));
    let result: Awaited<ReturnType<CodexRunner["client"]["steer"]>>;
    try {
      result = await this.opts.runner.client.steer(current.threadId, current.codexTurnId, [{ type: "text", text: rendered.text }],
        { clientUserMessageId: input.inboundKey });
    } catch (error) {
      if (error instanceof ThreadNotLoadedError) return "no_active_turn";
      throw error;
    }
    if (result !== "ok") return "no_active_turn";
    trace.event("turn:" + turnId, "steered", { detail: { backend: "codex", input: input.inboundKey } });
    return "ok";
  }

  /**
   * 面板"停止"、看门狗（§8.2）：中止线程上进行中的回合与运行中的子 agent 回合；回合结束仍由 turn/completed 回报。
   * 之后 STOP_WAKE_MS 内（直到下一次开轮）服务端开的唤醒回合判为 suppressed 并中止。
   */
  async interrupt(threadKey: ThreadKey): Promise<void> {
    const threadId = this.threadIds.get(threadKey);
    if (!threadId) return;
    this.stopped.set(threadKey, Date.now() + STOP_WAKE_MS);
    const client = this.opts.runner.client;
    const turns = new Set(this.liveTurns(threadId).filter(rec => rec.kind !== "compaction").map(rec => rec.codexTurnId));
    const active = client.thread(threadId)?.activeTurnId;
    if (active && this.turnRecs.get(active)?.kind !== "compaction") turns.add(active);
    const jobs = [...[...turns].map(turn => client.interrupt(threadId, turn)),
      ...[...this.children.get(threadKey) ?? []].flatMap(([child, childTurn]) => childTurn ? [client.interruptChild(child, childTurn)] : [])];
    await Promise.all(jobs.map(job => job.catch(error => log.warn("codex interrupt failed", { thread: threadKey, error }))));
  }

  /**
   * 宿主放弃的回合（被唤醒回合取代）：已结束的给出真实结果；仍在运行的中止（其工具调用随即因不是宿主当前回合被拒），按 lost 结束。
   */
  async abandon(threadKey: ThreadKey, turnId: string): Promise<TurnOutcome> {
    const ended = this.ended.get(turnId);
    if (ended) return ended;
    const rec = [...this.turnRecs.values()].find(r => r.key === threadKey && hostTurnId(r.codexTurnId) === turnId && !r.ended);
    if (!rec) return { status: "lost", error: "codex 回合已不在运行" };
    // 宿主不再跟踪：之后的结束事件交给宿主时按过期忽略
    await this.opts.runner.client.interrupt(rec.threadId, rec.codexTurnId).catch(error => log.warn("codex interrupt failed", { thread: threadKey, error }));
    return { status: "lost", error: "回合已被取代" };
  }

  /** 该会话仍有进行中的回合、运行中的子 agent 或压缩：后端切换须等待。 */
  async busy(threadKey: ThreadKey): Promise<boolean> {
    const threadId = this.threadIds.get(threadKey);
    if (!threadId) return !!this.children.get(threadKey)?.size || [...this.turnRecs.values()].some(rec => rec.key === threadKey && !rec.ended);
    return this.threadBusy(threadKey, threadId) || this.compactions.has(threadId);
  }

  /** 回合随 cs-agent 进程退出丢失（app-server 是子进程，§5.4）。 */
  async recoverTurn(): Promise<"lost"> { return "lost"; }

  /** 等待回合结束的收尾（补收图片、用量）完成（测试与关闭用）。 */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  // ───────────── 工具调用 ─────────────

  /**
   * 工具调用的绑定（§5.3、§7.3）：调用须来自会话主线程、属于宿主当前回合。归属只认服务端记录：
   * _meta 须带本线程的 thread_id 与 callId，callId 须是本线程某回合的 mcpToolCall 条目（来自 app-server 的条目事件），
   * 元数据里的 turn_id 若给出须与条目所在回合一致，该回合须是宿主当前回合。条目或宿主确认开轮的事件可能稍晚到达，最多等待 callWaitMs。
   */
  async resolveCall(threadKey: ThreadKey, meta: CallMeta): Promise<CallBinding> {
    const threadId = this.threadIds.get(threadKey);
    if (!threadId) throw new Error("会话线程未加载，工具调用不再有效");
    if (!meta.threadId || !meta.callId) throw new Error("缺少调用归属，无法确认所属回合");
    if (meta.threadId !== threadId) throw new Error("子 agent 不能使用此工具，请在主线程调用");
    const deadline = Date.now() + (this.opts.callWaitMs ?? 5_000);
    for (;;) {
      const call = this.calls.get(meta.callId);
      if (call && (call.threadId !== threadId || (meta.turnId && meta.turnId !== call.turnId))) throw new Error("调用归属不一致，拒绝");
      const codexTurnId = call?.turnId;
      const binding = this.opts.turns.binding(threadKey);
      if (codexTurnId && binding.turnId === hostTurnId(codexTurnId)) {
        const identity = binding.identity;
        const person = identity.kind === "user" ? identity.sender : identity.kind === "scheduled" ? identity.creator : undefined;
        const ownerPerson = !!person && isOwner(this.owners(), person);
        const access = ownerPerson || (!person && threadKey === "owner") ? { kind: "all" as const } : { kind: "scope" as const, scope: binding.scope };
        const images = binding.inputs.length ? this.opts.turns.records(binding.inputs.map(inboundKey => ({ inboundKey }))).flatMap(rec => rec.images) : [];
        return { ...binding, turnId: binding.turnId, access, workdir: this.opts.runner.workspaceOf(threadKey), session: threadId,
          imageDir: attachmentDirs(path.dirname(this.opts.imagesDir), threadKey).attachDir, imageRefs: images.slice(-3) };
      }
      if (Date.now() >= deadline) {
        throw new Error(codexTurnId ? "本回合已结束，工具调用不再有效" : "找不到这次调用的回合记录，拒绝");
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }

  // ───────────── 面板 ─────────────

  /** 面板"重置线程"：会话空闲时归档并清除线程记录，下一轮新建线程。 */
  resetThread(threadKey: ThreadKey, reason = "dashboard"): Promise<string | null> {
    return this.serial(threadKey, async () => {
      if (await this.busy(threadKey)) throw new Error("会话正在处理中，稍后再重置");
      const archived = await this.opts.runner.resetThread(threadKey, reason);
      this.unload(threadKey);
      return archived;
    });
  }

  /** 面板"压缩"：会话空闲时经常驻 app-server 压缩线程上下文（压缩回合不交给宿主），完成后刷新用量。 */
  compactThread(threadKey: ThreadKey, model?: string): Promise<"compacted" | "unchanged"> {
    return this.serial(threadKey, async () => {
      if (!await this.opts.runner.threadId(threadKey)) return "unchanged";
      if (await this.busy(threadKey)) throw new Error("会话正在处理中，稍后再压缩");
      const threadId = await this.ensureThread(threadKey, model);
      const startedAt = Date.now();
      const detail = { thread_key: threadKey, thread_id: threadId };
      log.info("codex thread compaction started", detail);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = new Promise<void>((resolve, reject) => {
        this.compactions.set(threadId, { done: error => { this.compactions.delete(threadId); error ? reject(error) : resolve(); } });
        timer = setTimeout(() => this.compactions.get(threadId)?.done(new Error("codex 压缩超时")), this.opts.compactTimeoutMs ?? 300_000);
      });
      try {
        await this.opts.runner.client.compactThread(threadId);
        await done;
      } catch (error) {
        this.compactions.get(threadId)?.done(error as Error);
        await done.catch(() => undefined);
        log.info("codex thread compaction ended", { ...detail, compacted: false, duration_ms: Date.now() - startedAt });
        throw error;
      } finally {
        clearTimeout(timer);
      }
      log.info("codex thread compaction ended", { ...detail, compacted: true, duration_ms: Date.now() - startedAt });
      await this.opts.runner.recordCompaction(threadKey, threadId, startedAt);
      return "compacted";
    });
  }

  // ───────────── app-server 事件 ─────────────

  /** 取得或建立回合簿记（待判定）。 */
  private record(key: ThreadKey, threadId: string, codexTurnId: string): TurnRec {
    let rec = this.turnRecs.get(codexTurnId);
    if (!rec) {
      rec = { key, threadId, codexTurnId, startedAt: Date.now(), hostVisible: false, buffered: [] };
      this.turnRecs.set(codexTurnId, rec);
    }
    return rec;
  }

  private onTurnStarted(threadId: string, codexTurnId: string, initiatedBy: "client" | "server"): void {
    const key = this.keys.get(threadId);
    if (!key || this.finished.has(codexTurnId)) return;
    const known = this.turnRecs.get(codexTurnId);
    const rec = this.record(key, threadId, codexTurnId);
    if (rec.kind !== undefined) {
      if (rec.kind === "user") this.host?.onTurnStarted(key, hostTurnId(codexTurnId), "host");
      return;
    }
    // client：turn/start 响应返回的 id → user
    if (initiatedBy === "client") return this.classify(rec, "user");
    if (known) {
      // 已在待判定中（开轮在途时由条目登记）
      const start = this.starting.get(threadId);
      if (start && !start.observed.includes(codexTurnId)) start.observed.push(codexTurnId);
      return;
    }
    // 开轮请求在途：待判定（由开轮结果或 clientId 决定），绝不按时机判为本轮
    if (this.starting.has(threadId)) { this.starting.get(threadId)!.observed.push(codexTurnId); return; }
    // 压缩期间：等首个条目判定
    if (this.compactions.has(threadId)) return;
    this.classify(rec, this.serverKind(key, threadId));
  }

  /** 判定回合种类（只一次）；判定前已结束的立即按结束处理。 */
  private classify(rec: TurnRec, kind: TurnKind, toHost = true): void {
    if (rec.kind !== undefined) return;
    rec.kind = kind;
    const turnId = hostTurnId(rec.codexTurnId);
    const buffered = rec.buffered.splice(0);
    if (kind === "user") {
      rec.hostVisible = true;
      this.host?.onTurnStarted(rec.key, turnId, "host");
    } else if (kind === "wake") {
      rec.hostVisible = toHost;
      rec.startedAt = Date.now();
      trace.event("turn:" + turnId, "dispatched", { detail: { backend: "codex", thread_key: rec.key, thread_id: rec.threadId, kind: "wake" } });
      trace.event("turn:" + turnId, "model_turn", { status: "started", detail: { backend: "codex", thread_key: rec.key } });
      if (toHost) this.host?.onTurnStarted(rec.key, turnId, "backend");
    } else if (kind === "suppressed") {
      log.info("codex wake suppressed after stop", { thread: rec.key, turn: rec.codexTurnId });
      if (!rec.ended) void this.opts.runner.client.interrupt(rec.threadId, rec.codexTurnId).catch(error => log.warn("codex interrupt failed", { thread: rec.key, error }));
    }
    // 判定前到达的条目：本轮或唤醒回合补记观测
    if (kind === "user" || kind === "wake") for (const b of buffered) observeItem("turn:" + turnId, b.phase, b.item);
    if (rec.ended) this.complete(rec, rec.ended);
  }

  private onTurnCompleted(e: TurnCompletedEvent): void {
    const failure = this.failures.get(e.turnId);
    const outcome: TurnOutcome = e.status === "completed" && !failure && !e.error ? { status: "completed" }
      : { status: "failed", error: failure ?? (e.status === "interrupted" ? "codex 回合被中断" : "codex 回合失败") };
    const kind = this.turnRecs.get(e.turnId)?.kind;
    if (outcome.status === "failed" && (kind === "user" || kind === "wake")) trace.event("turn:" + hostTurnId(e.turnId), "model_error", { status: "failed",
      detail: { backend: "codex", status: e.status, failure: classifyFailure(e.error?.message, "codex") } });
    this.endTurn(e.threadId, e.turnId, outcome);
  }

  /**
   * 回合结束（turn/completed、turnLost）：每个回合都处理。待判定的先记下结果：压缩期间没有条目就结束 → compaction；
   * 开轮在途的由开轮结果判定后处理。
   */
  private endTurn(threadId: string, codexTurnId: string, outcome: TurnOutcome): void {
    this.failures.delete(codexTurnId);
    const key = this.keys.get(threadId) ?? this.turnRecs.get(codexTurnId)?.key;
    if (!key || this.finished.has(codexTurnId)) return;
    const rec = this.record(key, threadId, codexTurnId);
    if (rec.ended) return;
    rec.ended = outcome;
    if (rec.kind !== undefined) return this.complete(rec, outcome);
    if (this.starting.get(threadId)?.observed.includes(codexTurnId)) return; // 由开轮结果判定
    this.classify(rec, this.compactions.has(threadId) ? "compaction" : this.serverKind(key, threadId));
  }

  /** 已判定回合的结束：清掉簿记；user / wake 交给宿主；compaction 释放压缩锁；宿主接管的 compaction / suppressed 按完成交给宿主。 */
  private complete(rec: TurnRec, outcome: TurnOutcome): void {
    this.turnRecs.delete(rec.codexTurnId);
    this.finished.set(rec.codexTurnId, { kind: rec.kind!, outcome });
    if (this.finished.size > 200) this.finished.delete(this.finished.keys().next().value!);
    const turnId = hostTurnId(rec.codexTurnId);
    if (rec.kind === "user" || rec.kind === "wake") {
      this.ended.set(turnId, outcome);
      if (this.ended.size > 200) this.ended.delete(this.ended.keys().next().value!);
      this.track(this.finish(rec, outcome));
      return;
    }
    if (rec.kind === "compaction") {
      this.compactions.get(rec.threadId)?.done(outcome.status === "completed" ? undefined : new Error("codex 压缩回合失败或被中断"));
    }
    if (rec.hostVisible) this.host?.onTurnCompleted(rec.key, turnId, { status: "completed" });
  }

  private async finish(rec: TurnRec, outcome: TurnOutcome): Promise<void> {
    const { key, threadId } = rec;
    const turnId = hostTurnId(rec.codexTurnId), ticket = "turn:" + turnId;
    const ms = Date.now() - rec.startedAt;
    trace.event(ticket, "model_turn", { status: outcome.status === "completed" ? "ok" : "failed", durationMs: ms,
      detail: { backend: "codex", thread_key: key, status: outcome.status, ...(outcome.error ? { reason: outcome.error } : {}) } });
    if (outcome.status === "completed") log.info("codex turn done", { thread: key, ms });
    else log.warn("codex turn ended", { thread: key, turn: turnId, status: outcome.status, error: outcome.error });
    const dir = attachmentDirs(path.dirname(this.opts.imagesDir), key).attachDir;
    await this.serialImages(key, () => this.lateImages(key, turnId, dir)).catch(error => log.warn("codex late images failed", { thread: key, error }));
    if (outcome.status !== "lost") {
      await this.opts.runner.recordTurnUsage(key, threadId, rec.startedAt, ticket, rec.model)
        .catch(error => log.warn("codex context usage failed", { thread: key, error }));
    }
    this.host?.onTurnCompleted(key, turnId, outcome);
  }

  private onItem(e: ItemEvent): void {
    const key = this.keys.get(e.threadId);
    if (!key) return;
    this.host?.onActivity(key);
    if (!e.turnId) return;
    // 调用归属不论回合是否已判定都记下：resolveCall 等到该回合判定并成为宿主当前回合
    if (e.item.type === "mcpToolCall" && typeof e.item.id === "string") {
      this.calls.set(e.item.id, { threadId: e.threadId, turnId: e.turnId });
      if (this.calls.size > 2000) this.calls.delete(this.calls.keys().next().value!);
    }
    const tomb = this.finished.get(e.turnId);
    if (tomb) {
      if (tomb.kind === "user" || tomb.kind === "wake") observeItem("turn:" + hostTurnId(e.turnId), e.phase, e.item);
      return;
    }
    let rec = this.turnRecs.get(e.turnId);
    const start = this.starting.get(e.threadId);
    if (!rec && start) {
      // 开轮在途：client 暂存了 turn/started，条目先到；登记为待判定（记下 clientId 供认领）
      rec = this.record(key, e.threadId, e.turnId);
      start.observed.push(e.turnId);
    } else if (!rec && e.item.type === "contextCompaction") rec = this.record(key, e.threadId, e.turnId);
    if (rec && rec.kind === undefined) {
      if (e.item.type === "userMessage" && typeof e.item.clientId === "string" && rec.clientId === undefined) rec.clientId = e.item.clientId;
      // 压缩期间（且没有开轮在途）：首个条目决定
      if (this.compactions.has(e.threadId) && !this.starting.get(e.threadId)?.observed.includes(e.turnId)) {
        this.classify(rec, e.item.type === "contextCompaction" ? "compaction" : "wake");
      }
    }
    if (rec?.kind === undefined) {
      // 未判定：先缓存，判定为本轮或唤醒回合时补记（有界）
      if (rec && rec.buffered.length < 200) rec.buffered.push({ phase: e.phase, item: e.item });
      if (rec) return;
    } else if (rec.kind !== "user" && rec.kind !== "wake") return;
    observeItem("turn:" + hostTurnId(e.turnId), e.phase, e.item);
  }

  /** 子 agent：alive=true 运行中（turnId 为其进行中的回合），false 已结束，undefined 只刷新活动时间。 */
  private onChild(parentThreadId: string, agentThreadId: string, alive: boolean | undefined, turnId?: string): void {
    const key = this.keys.get(parentThreadId);
    if (!key) return;
    this.host?.onActivity(key);
    if (alive === undefined) return;
    const live = this.children.get(key) ?? new Map<string, string | undefined>();
    if (alive) live.set(agentThreadId, turnId ?? live.get(agentThreadId)); else live.delete(agentThreadId);
    if (live.size) this.children.set(key, live); else this.children.delete(key);
  }

  // ───────────── 内部 ─────────────

  private serial<T>(threadKey: ThreadKey, work: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(threadKey) ?? Promise.resolve()).then(work);
    const tail = run.then(() => undefined, () => undefined);
    this.chains.set(threadKey, tail);
    void tail.then(() => { if (this.chains.get(threadKey) === tail) this.chains.delete(threadKey); });
    return run;
  }

  private serialImages<T>(threadKey: ThreadKey, work: () => Promise<T>): Promise<T> {
    const run = (this.imageChains.get(threadKey) ?? Promise.resolve()).then(work);
    const tail = run.then(() => undefined, () => undefined);
    this.imageChains.set(threadKey, tail);
    void tail.then(() => { if (this.imageChains.get(threadKey) === tail) this.imageChains.delete(threadKey); });
    return run;
  }

  private track(work: Promise<unknown>): void {
    const p = work.catch(error => log.warn("codex turn finish failed", { error })).finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  /**
   * image_gen 等待超时只留下任务清单（prompt_id 已落盘）；回合结束时（按会话串行）按清单补收，每个任务以稳定键
   * `<会话>:sys:img:<任务前缀>` 发一条系统消息（重复补收取回同一行，不重发），只移除这次处理过的任务。
   */
  private async lateImages(threadKey: ThreadKey, turnId: string, dir: string): Promise<void> {
    // image_gen MCP 写在会话目录的旁路事件先入观测库。
    await ingestImageEvents(dir, undefined, "turn:" + turnId);
    let jobs: Awaited<ReturnType<typeof readPendingImages>>;
    try { jobs = await readPendingImages(dir); }
    catch (err) {
      if (!(err instanceof PendingImageMarkerError)) throw err;
      await quarantinePendingImages(dir).catch(() => undefined);
      jobs = [];
    }
    if (!jobs.length) return;
    const pending = jobs.filter(job => job.status !== "done");
    for (const job of pending) {
      let images: string[] = [];
      try {
        if (!job.prompt_id || !this.opts.imageBackend) throw new UnknownJobError("intent");
        const callDir = await pendingCallDir(dir, job.callDir);
        await observeImages(this.opts.imageBackend, "turn:" + turnId).collect(job.prompt_id, callDir, AbortSignal.timeout(Math.ceil(imageTimeoutMs(job.options, this.opts.imageTimeoutCapMs ?? 300_000))), job.options);
        images = await collectNewImages(callDir, new Set());
      } catch (err) {
        log.warn("codex late image not collected", { thread: threadKey, prompt_id: job.prompt_id, error: err });
      }
      if (!this.opts.sendService) continue;
      const binding = this.opts.turns.binding(threadKey);
      await this.opts.sendService.system({ ...binding, turnId }, images.length ? IMAGE_SUCCESS_REPLY : "有图片生成超时未能发送", images.slice(0, 4),
        { key: `${threadKey}:sys:img:${job.filenamePrefix}` });
    }
    if (this.opts.imageBackend) await recoverRemoteUploads(dir, this.opts.imageBackend).catch(() => undefined);
    await removePendingImages(dir, new Set(jobs.map(job => job.filenamePrefix)));
  }
}

/** app-server 条目 → 观测事件：只提取白名单字段，不把原始条目（可能含凭据）存入观测库。 */
export function observeItem(ticket: string, phase: "started" | "completed", item: ThreadItem): void {
  const done = phase === "completed";
  const id = String(item.id ?? item.type).slice(0, 128);
  const duration = typeof item.durationMs === "number" ? item.durationMs : undefined;
  const failed = item.status === "failed" || (item.error !== undefined && item.error !== null);
  if (item.type === "agentMessage") {
    if (done && typeof item.text === "string") trace.event(ticket, "final_answer", { detail: { text: item.text } });
    return;
  }
  if (item.type === "mcpToolCall") {
    trace.event(ticket, "tool:" + String(item.tool ?? "unknown").slice(0, 128), { status: done ? (failed ? "failed" : "ok") : "started",
      durationMs: done ? duration : undefined, detail: { backend: "codex", server: item.server, call_id: id, input: item.arguments,
        output: item.result, error: item.error, failure: done && failed ? classifyFailure(item.error, String(item.server ?? "codex")) : undefined } });
    return;
  }
  if (item.type !== "commandExecution" && item.type !== "webSearch") return;
  const command = item.type === "commandExecution";
  const summary = command ? { command: redactText(String(item.command ?? ""), 200) } : { query: redactText(String(item.query ?? ""), 200) };
  const exit = typeof item.exitCode === "number" ? item.exitCode : null;
  trace.event(ticket, command ? "tool:command_execution" : "tool:web_search", {
    status: !done ? "started" : failed || (command && exit !== null && exit !== 0) ? "failed" : "ok",
    durationMs: done ? duration : undefined, detail: { backend: "codex", call_id: id, ...summary, ...(command && done ? { exit_code: exit } : {}) } });
}

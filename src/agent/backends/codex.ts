/**
 * codex 后端：常驻 app-server 适配器（设计 §5、§14 第 3 步），实现 ThreadHost 的 ThreadAdapter。
 * - 线程：会话键 → codex 线程（CodexRunner 的映射与轮换）；进程代中首次使用时 thread/start 或 thread/resume，
 *   同时为该会话签发线程令牌，写入 im / qq_context / image_gen 的线程级 MCP 环境；重启后令牌作废、按需重新加载。
 * - 回合：开一轮 turn/start（effort、model 每轮传入），回合 id 为 `codex:<codex 回合 id>`；插话 turn/steer
 *   （no_active_turn、not_steerable 都回报 no_active_turn，宿主改为排队）；停止 turn/interrupt。
 *   app-server 自己开的回合（子 agent 完成唤醒）以 initiatedBy=backend 交给宿主，身份为唤醒回合。
 * - 结束：turn/completed（completed → completed；interrupted、failed 或此前有不再重试的 error → failed）、
 *   进程掉线 → lost（宿主发 §8.1 的中断提示）。不设单轮时限，停滞由宿主看门狗按事件判定（条目、子 agent 活动都算）。
 * - 工具调用（§5.3、§7.3）：resolveCall 按 MCP 请求的 _meta（x-codex-turn-metadata 的 turn_id，或 callId 对应的
 *   mcpToolCall 条目所在回合）确认调用属于宿主当前回合，才按本轮身份给出绑定；子 agent 线程的调用、过期回合的调用一律拒绝。
 * - 忙：有进行中的回合、子 agent 线程仍在运行或正在压缩时，后端切换须等待（busy）。
 * - 生图：image_gen 等待超时的任务留在会话目录的清单里，回合结束时补收并以系统消息发出（跨回合仍在生成的不跟踪）。
 * - 压缩：面板"压缩"在会话空闲时经同一 app-server 发 thread/compact/start，压缩回合不交给宿主。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { classifyFailure } from "../../shared/errors.js";
import { redactText } from "../../shared/redact.js";
import { trace } from "../../shared/trace.js";
import { log } from "../../shared/log.js";
import { isOwner, type OwnerIds } from "../../shared/owners.js";
import { isReasoningEffort, type CodexRunner } from "../codex/runner.js";
import { ThreadNotLoadedError, type ItemEvent, type ThreadItem, type TurnCompletedEvent, type UserInput } from "../codex/app-server/client.js";
import type { ReasoningEffort, TicketSettings } from "./types.js";
import { collectNewImages } from "../../media/gen/image-collect.js";
import { attachmentDirs } from "../../media/attach-paths.js";
import { imageTimeoutMs } from "../../media/gen/image-options.js";
import { PENDING_IMAGE_JOBS, pendingCallDir, PendingImageMarkerError, quarantinePendingImages, readPendingImages } from "../../media/gen/image-pending.js";
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

/** 宿主跟踪的 codex 回合 */
interface Active {
  turnId: string;
  codexTurnId: string;
  threadId: string;
  startedAt: number;
  model?: string;
}

interface Compaction { turnId?: string; done(error?: Error): void }

const hostTurnId = (codexTurnId: string) => "codex:" + codexTurnId;
const TERMINAL_CHILD = /complet|error|fail|interrupt|clos|shut|cancel|abort/i;

export class CodexBackend implements ThreadAdapter {
  readonly name = "codex" as const;
  private host?: HostCallbacks;
  /** 本进程代已加载的会话线程 */
  private readonly threadIds = new Map<ThreadKey, string>();
  private readonly keys = new Map<string, ThreadKey>();
  private readonly active = new Map<ThreadKey, Active>();
  /** 最近结束的回合结果：宿主放弃回合时结束事件可能还排在宿主队列里，据此给出真实结果 */
  private readonly ended = new Map<string, TurnOutcome>();
  /** codex 回合 → 不再重试的 error（turn/completed 时并入结果） */
  private readonly failures = new Map<string, string>();
  /** mcpToolCall 条目 id（= MCP _meta.callId）→ 所在线程与 codex 回合 */
  private readonly calls = new Map<string, { threadId: string; turnId: string }>();
  /** 会话 → 仍在运行的子 agent 线程 */
  private readonly children = new Map<ThreadKey, Set<string>>();
  private readonly compactions = new Map<string, Compaction>();
  /** 压缩回合：结束事件不交给宿主 */
  private readonly compactionTurns = new Set<string>();
  /** 每个会话的加载、开轮、压缩、重置串行 */
  private readonly chains = new Map<ThreadKey, Promise<unknown>>();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly opts: CodexBackendOptions) {
    const initial = typeof opts.reasoningEffort === "function" ? opts.reasoningEffort() : opts.reasoningEffort;
    if (initial && !isReasoningEffort(initial)) {
      log.warn("CODEX_REASONING_EFFORT not in the allowed list; per-turn override omitted", { value: initial });
    }
    const client = opts.runner.client;
    client.on("turnStarted", e => this.onTurnStarted(e.threadId, e.turnId, e.initiatedBy));
    client.on("turnCompleted", e => this.onTurnCompleted(e));
    client.on("turnLost", e => this.onTurnEnded(e.threadId, e.turnId, { status: "lost", error: "codex app-server 掉线：" + e.reason }));
    client.on("turnError", e => {
      if (!e.turnId) return;
      const key = this.keys.get(e.threadId);
      if (key) trace.event("turn:" + hostTurnId(e.turnId), "model_error", { status: "failed", detail: { backend: "codex", will_retry: e.willRetry,
        failure: classifyFailure(e.error?.message, "codex") } });
      if (!e.willRetry) this.failures.set(e.turnId, "codex 回合出错");
    });
    client.on("item", e => this.onItem(e));
    client.on("subAgent", e => this.onChild(e.parentThreadId, e.agentThreadId, !TERMINAL_CHILD.test(e.kind)));
    client.on("childActivity", e => {
      const alive = e.method === "turn/started" ? true : e.method === "turn/completed" ? false : undefined;
      this.onChild(e.parentThreadId, e.agentThreadId, alive);
    });
    // 进程掉线：进行中的回合由 client 以 turnLost 上报；线程、子 agent 与压缩随进程丢失，令牌作废，重新加载时重新签发。
    opts.runner.supervisor.on("down", () => {
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
      if (snapshot.activeTurnId || this.children.get(threadKey)?.size || !await this.opts.runner.rotationDue(threadKey)) return loaded;
      this.unload(threadKey);
    }
    const token = this.opts.tokens.issue(threadKey);
    const threadId = await this.opts.runner.openThread(threadKey, { model,
      mcpEnv: { im: { IM_TOKEN: token }, qq_context: { QQ_RECALL_TOKEN: token }, image_gen: { IMAGE_GEN_TOKEN: token } } });
    this.threadIds.set(threadKey, threadId);
    this.keys.set(threadId, threadKey);
    return threadId;
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
    const input: UserInput[] = [{ type: "text", text: rendered.text }];
    return this.serial(threadKey, async () => {
      let threadId = await this.ensureThread(threadKey, model);
      // 唤醒回合先到（宿主还没处理它的开始事件）：本轮让给它，输入放回队列
      const running = this.opts.runner.client.thread(threadId)?.activeTurnId;
      if (running) return { backendTurnId: hostTurnId(running) };
      const startedAt = Date.now();
      let codexTurnId: string;
      try {
        codexTurnId = await this.opts.runner.client.startTurn(threadId, input, { ...(effort ? { effort } : {}), ...(model ? { model } : {}) });
      } catch (error) {
        if (!(error instanceof ThreadNotLoadedError)) throw error;
        this.unload(threadKey);
        threadId = await this.ensureThread(threadKey, model);
        codexTurnId = await this.opts.runner.client.startTurn(threadId, input, { ...(effort ? { effort } : {}), ...(model ? { model } : {}) });
      }
      const turnId = hostTurnId(codexTurnId);
      // 结束事件可能先于响应到达（已记入 ended）：不再登记为进行中
      if (!this.ended.has(turnId)) this.active.set(threadKey, { turnId, codexTurnId, threadId, startedAt, ...(model ? { model } : {}) });
      trace.event("turn:" + turnId, "dispatched", { detail: { backend: "codex", thread_key: threadKey, thread_id: threadId, kind: turn.kind,
        effort: effort ?? null, inputs: inputs.map(i => i.inboundKey) } });
      trace.event("turn:" + turnId, "model_turn", { status: "started", detail: { backend: "codex", thread_key: threadKey, effort: effort ?? null } });
      return { turnId };
    });
  }

  /** 插话进当前回合；回合已结束、id 不符或当前回合不可插话时回报 no_active_turn（宿主排队）。 */
  async steer(threadKey: ThreadKey, turnId: string, input: InputRef): Promise<"ok" | "no_active_turn"> {
    const current = this.active.get(threadKey);
    if (current?.turnId !== turnId) return "no_active_turn";
    const rendered = await this.opts.turns.render(this.opts.turns.records([input]));
    let result: Awaited<ReturnType<CodexRunner["client"]["steer"]>>;
    try {
      result = await this.opts.runner.client.steer(current.threadId, current.codexTurnId, [{ type: "text", text: rendered.text }]);
    } catch (error) {
      if (error instanceof ThreadNotLoadedError) return "no_active_turn";
      throw error;
    }
    if (result !== "ok") return "no_active_turn";
    trace.event("turn:" + turnId, "steered", { detail: { backend: "codex", input: input.inboundKey } });
    return "ok";
  }

  /** 面板"停止"、看门狗：turn/interrupt；回合结束仍由 turn/completed 回报。子 agent 线程不在此中止。 */
  async interrupt(threadKey: ThreadKey): Promise<void> {
    const threadId = this.threadIds.get(threadKey);
    const turn = this.active.get(threadKey)?.codexTurnId ?? (threadId ? this.opts.runner.client.thread(threadId)?.activeTurnId : undefined);
    if (!threadId || !turn) return;
    await this.opts.runner.client.interrupt(threadId, turn).catch(error => log.warn("codex interrupt failed", { thread: threadKey, error }));
  }

  /**
   * 宿主放弃的回合（被唤醒回合取代）：已结束的给出真实结果；仍在运行的中止（其工具调用随即因不是宿主当前回合被拒），按 lost 结束。
   */
  async abandon(threadKey: ThreadKey, turnId: string): Promise<TurnOutcome> {
    const ended = this.ended.get(turnId);
    if (ended) return ended;
    const current = this.active.get(threadKey);
    if (current?.turnId !== turnId) return { status: "lost", error: "codex 回合已不在运行" };
    this.active.delete(threadKey);
    await this.opts.runner.client.interrupt(current.threadId, current.codexTurnId).catch(error => log.warn("codex interrupt failed", { thread: threadKey, error }));
    return { status: "lost", error: "回合已被取代" };
  }

  /** 该会话仍有进行中的回合、运行中的子 agent 或压缩：后端切换须等待。 */
  async busy(threadKey: ThreadKey): Promise<boolean> {
    const threadId = this.threadIds.get(threadKey);
    return this.active.has(threadKey) || !!this.children.get(threadKey)?.size
      || (!!threadId && (!!this.opts.runner.client.thread(threadId)?.activeTurnId || this.compactions.has(threadId)));
  }

  /** 回合随 cs-agent 进程退出丢失（app-server 是子进程，§5.4）。 */
  async recoverTurn(): Promise<"lost"> { return "lost"; }

  /** 等待回合结束的收尾（补收图片、用量）完成（测试与关闭用）。 */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  // ───────────── 工具调用 ─────────────

  /**
   * 工具调用的绑定（§5.3、§7.3）：调用须来自会话主线程、属于宿主当前回合。回合由 _meta 的 turn_id 给出，
   * 否则按 callId 找到其 mcpToolCall 条目所在回合；条目或宿主确认开轮的事件可能稍晚到达，最多等待 callWaitMs。
   */
  async resolveCall(threadKey: ThreadKey, meta: CallMeta): Promise<CallBinding> {
    const threadId = this.threadIds.get(threadKey);
    if (!threadId) throw new Error("会话线程未加载，工具调用不再有效");
    if (meta.threadId && meta.threadId !== threadId) throw new Error("子 agent 不能使用此工具，请在主线程调用");
    const deadline = Date.now() + (this.opts.callWaitMs ?? 5_000);
    for (;;) {
      const call = meta.callId ? this.calls.get(meta.callId) : undefined;
      const codexTurnId = meta.turnId ?? (call?.threadId === threadId ? call.turnId : undefined);
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
        throw new Error(codexTurnId || meta.callId || meta.turnId ? "本回合已结束，工具调用不再有效" : "缺少调用归属，无法确认所属回合");
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

  private onTurnStarted(threadId: string, codexTurnId: string, initiatedBy: "client" | "server"): void {
    const key = this.keys.get(threadId);
    if (!key) return;
    if (this.compactionTurns.has(codexTurnId)) return;
    const compaction = this.compactions.get(threadId);
    if (compaction && initiatedBy === "server" && !compaction.turnId) {
      compaction.turnId = codexTurnId;
      this.compactionTurns.add(codexTurnId);
      return;
    }
    const turnId = hostTurnId(codexTurnId);
    if (initiatedBy === "server") {
      this.active.set(key, { turnId, codexTurnId, threadId, startedAt: Date.now() });
      trace.event("turn:" + turnId, "dispatched", { detail: { backend: "codex", thread_key: key, thread_id: threadId, kind: "wake" } });
      trace.event("turn:" + turnId, "model_turn", { status: "started", detail: { backend: "codex", thread_key: key } });
    }
    this.host?.onTurnStarted(key, turnId, initiatedBy === "server" ? "backend" : "host");
  }

  private onTurnCompleted(e: TurnCompletedEvent): void {
    if (this.compactionTurns.delete(e.turnId)) {
      const compaction = this.compactions.get(e.threadId);
      compaction?.done(e.status === "completed" && !e.error ? undefined : new Error("codex 压缩回合失败或被中断"));
      return;
    }
    const failure = this.failures.get(e.turnId);
    const outcome: TurnOutcome = e.status === "completed" && !failure && !e.error ? { status: "completed" }
      : { status: "failed", error: failure ?? (e.status === "interrupted" ? "codex 回合被中断" : "codex 回合失败") };
    if (outcome.status === "failed") trace.event("turn:" + hostTurnId(e.turnId), "model_error", { status: "failed", detail: { backend: "codex",
      status: e.status, failure: classifyFailure(e.error?.message, "codex") } });
    this.onTurnEnded(e.threadId, e.turnId, outcome);
  }

  /** 回合结束：记下结果，补收图片与用量后回报宿主。 */
  private onTurnEnded(threadId: string, codexTurnId: string, outcome: TurnOutcome): void {
    this.failures.delete(codexTurnId);
    if (this.compactionTurns.delete(codexTurnId)) {
      this.compactions.get(threadId)?.done(new Error("codex 压缩回合丢失"));
      return;
    }
    const key = this.keys.get(threadId) ?? [...this.active].find(([, a]) => a.threadId === threadId)?.[0];
    if (!key) return;
    const turnId = hostTurnId(codexTurnId);
    this.ended.set(turnId, outcome);
    if (this.ended.size > 200) this.ended.delete(this.ended.keys().next().value!);
    const current = this.active.get(key);
    if (current?.codexTurnId === codexTurnId) this.active.delete(key);
    this.track(this.finish(key, threadId, turnId, current?.codexTurnId === codexTurnId ? current : undefined, outcome));
  }

  private async finish(key: ThreadKey, threadId: string, turnId: string, current: Active | undefined, outcome: TurnOutcome): Promise<void> {
    const ticket = "turn:" + turnId;
    const ms = current ? Date.now() - current.startedAt : undefined;
    trace.event(ticket, "model_turn", { status: outcome.status === "completed" ? "ok" : "failed", durationMs: ms,
      detail: { backend: "codex", thread_key: key, status: outcome.status, ...(outcome.error ? { reason: outcome.error } : {}) } });
    if (outcome.status === "completed") log.info("codex turn done", { thread: key, ms });
    else log.warn("codex turn ended", { thread: key, turn: turnId, status: outcome.status, error: outcome.error });
    const dir = attachmentDirs(path.dirname(this.opts.imagesDir), key).attachDir;
    await this.lateImages(key, turnId, dir).catch(error => log.warn("codex late images failed", { thread: key, error }));
    if (outcome.status !== "lost") {
      await this.opts.runner.recordTurnUsage(key, threadId, current?.startedAt ?? 0, ticket, current?.model)
        .catch(error => log.warn("codex context usage failed", { thread: key, error }));
    }
    this.host?.onTurnCompleted(key, turnId, outcome);
  }

  private onItem(e: ItemEvent): void {
    const key = this.keys.get(e.threadId);
    if (!key) return;
    this.host?.onActivity(key);
    if (e.item.type === "contextCompaction" && e.phase === "completed") {
      const compaction = this.compactions.get(e.threadId);
      if (compaction) {
        // 压缩条目先于（或不伴随）回合事件完成：该回合之后的开始、结束事件同样不交给宿主
        if (e.turnId) this.compactionTurns.add(e.turnId);
        compaction.done();
        return;
      }
    }
    if (!e.turnId || this.compactionTurns.has(e.turnId)) return;
    if (e.item.type === "mcpToolCall" && typeof e.item.id === "string") {
      this.calls.set(e.item.id, { threadId: e.threadId, turnId: e.turnId });
      if (this.calls.size > 2000) this.calls.delete(this.calls.keys().next().value!);
    }
    observeItem("turn:" + hostTurnId(e.turnId), e.phase, e.item);
  }

  /** 子 agent：alive=true 运行中，false 已结束，undefined 只刷新活动时间。 */
  private onChild(parentThreadId: string, agentThreadId: string, alive: boolean | undefined): void {
    const key = this.keys.get(parentThreadId);
    if (!key) return;
    this.host?.onActivity(key);
    if (alive === undefined) return;
    const set = this.children.get(key) ?? new Set<string>();
    if (alive) set.add(agentThreadId); else set.delete(agentThreadId);
    if (set.size) this.children.set(key, set); else this.children.delete(key);
  }

  // ───────────── 内部 ─────────────

  private serial<T>(threadKey: ThreadKey, work: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(threadKey) ?? Promise.resolve()).then(work);
    const tail = run.then(() => undefined, () => undefined);
    this.chains.set(threadKey, tail);
    void tail.then(() => { if (this.chains.get(threadKey) === tail) this.chains.delete(threadKey); });
    return run;
  }

  private track(work: Promise<unknown>): void {
    const p = work.catch(error => log.warn("codex turn finish failed", { error })).finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  /**
   * image_gen 等待超时只留下任务清单（prompt_id 已落盘）；回合结束时按清单补收，完成的图片以系统消息发往本会话。
   * 清单收取后整体移除，下一轮重新开始计数（MCP 清单最多 8 条）。
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
    const pending = jobs.filter(job => job.status !== "done");
    const images: string[] = [];
    let failed = 0;
    for (const job of pending) {
      try {
        if (!job.prompt_id || !this.opts.imageBackend) throw new UnknownJobError("intent");
        const callDir = await pendingCallDir(dir, job.callDir);
        await observeImages(this.opts.imageBackend, "turn:" + turnId).collect(job.prompt_id, callDir, AbortSignal.timeout(Math.ceil(imageTimeoutMs(job.options, this.opts.imageTimeoutCapMs ?? 300_000))), job.options);
        images.push(...await collectNewImages(callDir, new Set()));
      } catch (err) {
        failed++;
        log.warn("codex late image not collected", { thread: threadKey, prompt_id: job.prompt_id, error: err });
      }
    }
    if (this.opts.imageBackend) await recoverRemoteUploads(dir, this.opts.imageBackend).catch(() => undefined);
    await fs.rm(path.join(dir, PENDING_IMAGE_JOBS), { force: true });
    if (!pending.length || !this.opts.sendService) return;
    const text = (images.length ? IMAGE_SUCCESS_REPLY : "") + (failed ? (images.length ? "\n" : "") + "有图片生成超时未能发送" : "");
    const binding = this.opts.turns.binding(threadKey);
    await this.opts.sendService.system({ ...binding, turnId }, text, images.slice(0, 4));
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

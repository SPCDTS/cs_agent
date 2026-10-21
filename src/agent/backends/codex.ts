import { classifyFailure } from "../../shared/errors.js";
import { redactText } from "../../shared/redact.js";
import { trace } from "../../shared/trace.js";
import { imageRefsValue } from "../../media/gen/image-references.js";
/**
 * codex 后端的第 2 阶段适配层（设计 §14 第 2 步）：每轮仍是一次 `codex exec`（CodexRunner），由 ThreadHost 驱动。
 * - 开一轮：立即返回回合 id（`codex:<uuid>`），exec 在后台运行，结束后回报 onTurnCompleted；
 * - 插话：codex exec 不能插话，一律返回 no_active_turn，消息排队到下一轮；
 * - 中止：面板"停止"与看门狗中止 exec 进程树；超时（CODEX_TIMEOUT_SEC）= 回合失败，按 §8.1 提示；
 * - 恢复：exec 随进程退出丢失，重启后回合按 lost 结束（不自动重放）；
 * - 线程：owner / group:<id> / private:<qq>，同键串行；读取范围按本轮身份（owner 本人 all，其余本会话）；
 * - IM / 召回令牌每次 exec 一个租约，绑定会话键与回合 id，身份在调用时由宿主求出；
 * - 生图输出目录按会话（${DATA_DIR}/images/<会话>）；image_gen 等待超时留下的任务在回合结束前补收，完成后以系统消息发出。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CodexTimeoutError, isReasoningEffort, type CodexRunner } from "../codex/runner.js";
import { type ReasoningEffort, type TicketSettings } from "./types.js";
import { collectNewImages } from "../../media/gen/image-collect.js";
import { attachmentDirs } from "../../media/attach-paths.js";
import { imageTimeoutMs } from "../../media/gen/image-options.js";
import { PENDING_IMAGE_JOBS, pendingCallDir, PendingImageMarkerError, quarantinePendingImages, readPendingImages } from "../../media/gen/image-pending.js";
import { recoverRemoteUploads, UnknownJobError, type ImageBackend } from "../../media/gen/image-gen.js";
import { ingestImageEvents } from "../../media/gen/events.js";
import { observeImages } from "../../media/gen/observed.js";
import { log } from "../../shared/log.js";
import { isOwner, type OwnerIds } from "../../shared/owners.js";
import type { HostCallbacks, InputRef, ThreadAdapter, ThreadKey, TurnContext, TurnStatus } from "../host/types.js";
import type { PiTurns } from "./pi.js";
import type { SendService } from "../send-service.js";
import { IMAGE_SUCCESS_REPLY } from "../replies.js";

export interface CodexBackendOptions {
  runner: Pick<CodexRunner, "ask">;
  /** ${DATA_DIR}/images：会话图片目录的根（须与 image_gen MCP 的 ${DATA_DIR}/images 一致） */
  imagesDir: string;
  /** CODEX_REASONING_EFFORT；不在允许列表内时不传覆盖参数（沿用 config.toml）。函数形式每回合现读（运行时设置）。 */
  reasoningEffort?: string | (() => string | undefined);
  turns: PiTurns;
  owners?: OwnerIds | (() => OwnerIds);
  /** 补收图片的发送（系统消息）；未接入时只记日志 */
  sendService?: Pick<SendService, "system">;
  imageBackend?: Pick<ImageBackend, "name" | "submit" | "collect" | "reconcile" | "clearReferences">;
  imageTimeoutCapMs?: number;
}

export class CodexBackend implements ThreadAdapter {
  readonly name = "codex" as const;
  private host?: HostCallbacks;
  private readonly running = new Map<string, { turnId: string; control: AbortController; done: Promise<void> }>();
  constructor(private readonly opts: CodexBackendOptions) {
    const initial = typeof opts.reasoningEffort === "function" ? opts.reasoningEffort() : opts.reasoningEffort;
    if (initial && !isReasoningEffort(initial)) {
      log.warn("CODEX_REASONING_EFFORT not in the allowed list; per-call override omitted", { value: initial });
    }
  }

  attach(host: HostCallbacks): void { this.host = host; }

  /** 本回合的推理强度（运行时设置可在两回合之间修改）。 */
  private get effort(): ReasoningEffort | undefined {
    const value = typeof this.opts.reasoningEffort === "function" ? this.opts.reasoningEffort() : this.opts.reasoningEffort;
    return isReasoningEffort(value) ? value : undefined;
  }

  private owners(): OwnerIds { return typeof this.opts.owners === "function" ? this.opts.owners() : this.opts.owners; }

  async startTurn(threadKey: ThreadKey, inputs: readonly InputRef[], turn: TurnContext, settings?: TicketSettings): Promise<{ turnId: string }> {
    const turnId = "codex:" + randomUUID(), control = new AbortController();
    // 先渲染：输入缺失等错误在开轮时就抛出，宿主按开轮失败处理。
    const rendered = await this.opts.turns.render(this.opts.turns.records(inputs));
    const done = this.run(threadKey, turnId, rendered, turn, settings, control.signal)
      .then(result => {
        // 被放弃的旧 exec 可能晚于下一轮结束：只移除自己
        if (this.running.get(threadKey)?.turnId === turnId) this.running.delete(threadKey);
        this.host?.onTurnCompleted(threadKey, turnId, result);
      });
    this.running.set(threadKey, { turnId, control, done });
    trace.event("turn:" + turnId, "dispatched", { detail: { backend: "codex", thread_key: threadKey, kind: turn.kind, inputs: inputs.map(i => i.inboundKey) } });
    return { turnId };
  }

  /** codex exec 不能插话：消息排队到下一轮。 */
  async steer(): Promise<"no_active_turn"> { return "no_active_turn"; }

  async interrupt(threadKey: ThreadKey): Promise<void> {
    this.running.get(threadKey)?.control.abort(new Error("回合已中止"));
  }

  /** 宿主放弃的回合（被唤醒回合取代）：中止仍在运行的 exec（连同其召回 / 发送租约），不能留到下一轮以新身份调用工具。 */
  async abandon(threadKey: ThreadKey, turnId: string): Promise<void> {
    const run = this.running.get(threadKey);
    if (run?.turnId === turnId) run.control.abort(new Error("回合已被取代"));
  }

  /** exec 随进程退出丢失（§5.4）。 */
  async recoverTurn(): Promise<"lost"> { return "lost"; }

  /** 等待所有在跑的回合结束（测试与关闭用）。 */
  async idle(): Promise<void> { await Promise.allSettled([...this.running.values()].map(r => r.done)); }

  private async run(threadKey: ThreadKey, turnId: string, rendered: Awaited<ReturnType<PiTurns["render"]>>, turn: TurnContext,
    settings: TicketSettings | undefined, signal: AbortSignal): Promise<{ status: TurnStatus; error?: string }> {
    const key = "turn:" + turnId;
    const binding = this.opts.turns.binding(threadKey);
    const person = turn.kind === "user" || turn.kind === "scheduled" ? turn.sender : undefined;
    const ownerPerson = !!person && isOwner(this.owners(), person);
    const access = ownerPerson || threadKey === "owner" ? "all" : binding.scope;
    const dir = attachmentDirs(path.dirname(this.opts.imagesDir), threadKey).attachDir;
    const started = Date.now();
    let modelStarted: number | undefined;
    const effort = settings ? settings.codexReasoningEffort : this.effort;
    try {
      await fs.mkdir(dir, { recursive: true });
      const refs = rendered.images.slice(-3);
      imageRefsValue(refs);
      const text = await this.opts.runner.ask(rendered.text, {
        turnId, threadKey, signal, senderIsOwner: ownerPerson,
        onJsonEvent: codexObserver(key, () => this.host?.onActivity(threadKey)),
        ...(settings?.codexModel !== undefined ? { model: settings.codexModel } : {}),
        ...(effort ? { reasoningEffort: effort } : {}),
        qqAccess: access, imageTicketDir: dir, imageRefs: refs,
        onAcquired: async () => {
          modelStarted = Date.now();
          trace.event(key, "thread_wait", { durationMs: modelStarted - started, detail: { backend: "codex", thread_key: threadKey } });
          trace.event(key, "model_turn", { status: "started", detail: { backend: "codex", thread_key: threadKey, effort } });
        },
      });
      trace.event(key, "model_turn", { durationMs: modelStarted === undefined ? undefined : Date.now() - modelStarted, detail: {
        backend: "codex", model_ms: modelStarted === undefined ? 0 : Date.now() - modelStarted, thread_key: threadKey, effort, raw_reply: text } });
      trace.event(key, "final_answer", { detail: { text } });
      await this.lateImages(threadKey, turnId, dir).catch(error => log.warn("codex late images failed", { thread: threadKey, error }));
      log.info("codex turn done", { thread: threadKey, effort: effort ?? "default", ms: Date.now() - started, chars: text.length });
      return { status: "completed" };
    } catch (err) {
      trace.event(key, "model_turn", { status: "failed", durationMs: modelStarted === undefined ? undefined : Date.now() - modelStarted, detail: {
        backend: "codex", thread_key: threadKey, effort, failure: classifyFailure(err, "codex"), error: err } });
      const reason = err instanceof CodexTimeoutError ? "timeout" : signal.aborted ? "aborted" : (err as Error).message;
      log.warn("codex turn failed", { thread: threadKey, turn: turnId, ms: Date.now() - started, error: reason });
      await this.lateImages(threadKey, turnId, dir).catch(error => log.warn("codex late images failed", { thread: threadKey, error }));
      return { status: "failed", error: reason };
    }
  }

  /**
   * image_gen 等待超时只留下任务清单（prompt_id 已落盘）；回合结束前按清单补收，完成的图片以系统消息发往本会话。
   * 清单收取后整体移除，下一轮重新开始计数（MCP 清单最多 8 条）。
   */
  private async lateImages(threadKey: string, turnId: string, dir: string): Promise<void> {
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

/** JSONL 只提取白名单字段，不把原始事件（可能含凭据）存入观测库。onActivity 刷新看门狗。 */
export function codexObserver(ticket: string, onActivity?: () => void): (event: Record<string, unknown>) => void {
  const starts = new Map<string, number>();
  let builtinCount = 0;
  return event => {
    onActivity?.();
    const item = event.item as Record<string, unknown> | undefined;
    if (event.type === "thread.started") trace.event(ticket, "dispatched", { detail: { backend: "codex", thread_id: event.thread_id } });
    if (event.type === "turn.completed") {
      const usage = event.usage as Record<string,unknown> | undefined;
      // exec 的 usage 是线程累计计费量，不是本次请求的上下文占用。
      trace.event(ticket,"model_usage",{detail:{backend:"codex",total_input_tokens:usage?.input_tokens,total_output_tokens:usage?.output_tokens,total_cached_input_tokens:usage?.cached_input_tokens}});
    }
    if (event.type === "turn.failed" || event.type === "error") trace.event(ticket,"model_error",{status:"failed",detail:{backend:"codex",failure:classifyFailure(event.error ?? event.message,"codex")}});
    if (!item || !['mcp_tool_call','command_execution','web_search','web_search_call'].includes(String(item.type))) return;
    const id = String(item.id ?? item.tool ?? item.type).slice(0,128);
    if (event.type === "item.started" && starts.size < 200) starts.set(id, Date.now());
    const done = event.type === "item.completed";
    const duration = typeof item.duration_ms === "number" ? item.duration_ms : starts.has(id) ? Date.now() - starts.get(id)! : undefined;
    if (item.type !== 'mcp_tool_call') {
      const command = item.type === 'command_execution';
      const action = item.action as Record<string,unknown> | undefined;
      const summary = command ? {command:redactText(String(item.command ?? ''),200)} : {query:redactText(String(item.query ?? action?.query ?? ''),200)};
      if (event.type === 'item.started') {
        // 开始事件只给实时视图看"正在执行什么"；与完成事件共用 100 条上限。
        if (builtinCount < 100) trace.event(ticket,command ? 'tool:command_execution' : 'tool:web_search',{status:'started',detail:{backend:'codex',call_id:id,...summary}});
        return;
      }
      if (!done) return;
      starts.delete(id);
      if (builtinCount++ >= 100) return;
      trace.event(ticket,command ? 'tool:command_execution' : 'tool:web_search',{status:item.status==='failed' || (command && typeof item.exit_code==='number' && item.exit_code!==0) ? 'failed':'ok',durationMs:duration,
        detail:{backend:'codex',call_id:id,...summary,...(command ? {exit_code:typeof item.exit_code==='number' ? item.exit_code : null} : {})}});
      return;
    }
    if (!['item.started','item.updated','item.completed'].includes(String(event.type))) return;
    const failed = item.status === 'failed' || !!item.error;
    trace.event(ticket, "tool:" + String(item.tool ?? item.name ?? "unknown").slice(0,128), { status: done ? (failed ? "failed" : "ok") : "started",
      durationMs: done ? duration : undefined, detail: { backend: "codex", server: item.server, call_id: id, input: item.arguments, output: item.result, error: item.error,
        failure: failed ? classifyFailure(item.error,String(item.server ?? 'codex')) : undefined } });
    if (done) starts.delete(id);
  };
}

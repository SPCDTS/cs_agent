import { ingestImageEvents } from "../obs/image-events.js";
import { trace } from "../obs/trace.js";
import { observeImages } from "../obs/image.js";
import path from "node:path";
import { imageTimeoutMs } from "./image-options.js";
import { validateReferences } from "./image-references.js";
/**
 * 每条 QQ 消息的 durable 任务（pi-durable defineTask，设计 §4.2 / §4.3）：
 * - 生图任务 `cs.image`：submit（提交 ComfyUI，prompt_id 立即落盘）→ collect（按 prompt_id 等待并下载）→ reply
 * - agent 任务 `cs.agent`：handle → lateImages → postprocess → reply
 *
 * 检查点语义：每个阶段把结果写进会话文档 TicketDoc，并在**同一次 runtime.commit** 里把检查点推进到下一阶段。
 * 进程在阶段之间崩溃时，任务从已提交的检查点继续：已完成的生图 / 后端调用不会重跑；
 * 即使任务本身失败、由派发器新建任务重跑，新任务也先看 TicketDoc，已有结果的阶段直接跳过。
 * reply 阶段依赖 QQBridge 票据幂等：sent → already_sent 不重发；sending/uncertain → 不重发、任务以 failed 结束；
 * 只有发送前就失败（票据仍 pending）才在任务内退避重试（≤3 次，次数记在检查点里）。
 * 进程关闭（runtime.signal 中止）时阶段直接抛出、不提交任何结果，重启后该阶段重跑。
 */
import type { Context } from "@earendil-works/chord";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { defineTask, type RunningTask, type TaskRuntime, type TaskDefinition } from "@earendil-works/pi-durable";
import { accessForSource, accessToString } from "../context/access.js";
import type { ContextStore } from "../context/store.js";
import type { QQBridge } from "../qq/types.js";
import { log } from "../log.js";
import { threadKeyForSource } from "./codex-runner.js";
import { DispatchDoc, TicketDoc, type AgentResult, type ImageResult, type TicketState } from "./docs.js";
import { collectNewImages } from "./image-collect.js";
import { PENDING_IMAGE_JOBS, pendingCallDir, readPendingImages, quarantinePendingImages, savePendingImage, PendingImageMarkerError } from "./image-pending.js";
import { readImageFiles, prepareImageFiles, validImageFile } from "./image-files.js";
import { classifyImageError, referenceUploads, recoverRemoteUploads, imageFilenamePrefix, ticketImageDir, UnknownJobError, type ImageBackend, type RemoteUpload } from "./image-gen.js";
import { AGENT_FAILURE_REPLIES, FALLBACK_REPLY, IMAGE_FAILURE_REPLIES, IMAGE_SUCCESS_REPLY } from "./replies.js";
import { postprocessReply, sanitizeReply, type ReplyMode } from "./reply-postprocess.js";
import { IMAGE_USAGE_REPLY } from "./router.js";
import { BackendTimeoutError } from "./backends/types.js";
import type { BackendSelector } from "./backends/select.js";
import { ticketWorkDir } from "./backends/codex.js";
import { promises as fs } from "node:fs";

export const IMAGE_TASK = "cs.image";
export const AGENT_TASK = "cs.agent";
/** reply 阶段在票据仍 pending 时的最多尝试次数 */
export const MAX_REPLY_ATTEMPTS = 3;

export type TaskInput = { ticket: string };
export type TaskResult = { sent: boolean; already_sent?: boolean };
type ReplyCheckpoint = { phase: "reply"; attempt: number };
/** generate 为 v3 初版的单阶段生图（仅为兼容已落盘的旧任务），按 submit 处理 */
export type ImageCheckpoint = { phase: "submit" } | { phase: "generate" } | { phase: "collect"; submits?: number; extensions?: number } | ReplyCheckpoint;
/** 同一票据最多提交 ComfyUI 任务的次数（服务端丢失任务时重新提交 1 次） */
export const MAX_IMAGE_SUBMITS = 2;
export type AgentCheckpoint = { phase: "handle" } | { phase: "lateImages"; job?: number; extensions?: number } | { phase: "postprocess" } | ReplyCheckpoint;

export interface TaskDeps {
  getBridge: () => Pick<QQBridge, "reply" | "getTicket">;
  imageBackend: Pick<ImageBackend, "submit" | "collect" | "reconcile" | "name" | "clearReferences">;
  imagesDir: string;
  imageTimeoutCapMs?: number;
  imageCollectExtensions?: number;
  imageCollectDelayMs?: number;
  /** ${DATA_DIR}/tickets：票据工作目录的根；reply 结束后清理该票据的子目录 */
  ticketsDir?: string;
  backends: BackendSelector;
  owner?: string;
  /** 统一上下文存储：查找 [引用] 正文 */
  store?: Pick<ContextStore, "message">;
  /** codex 后端的回复模式（pi 后端恒为 direct）；relay 需要 models + model */
  codexReplyMode: ReplyMode;
  models?: Models;
  relayModel?: Model<Api>;
  /** reply 重试退避基数（毫秒），默认 2000 */
  replyRetryDelayMs?: number;
}

type Runtime<S extends { phase: string }> = TaskRuntime<TaskInput, S, TaskResult, object>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRuntime = TaskRuntime<TaskInput, any, TaskResult, object>;

async function ticketDoc(runtime: Pick<AnyRuntime, "snapshot" | "conversationId">, context: Context): Promise<Readonly<TicketState>> {
  const doc = await runtime.snapshot(TicketDoc, runtime.conversationId, context);
  if (!doc?.ticket) throw new Error("conversation has no bound QQ ticket");
  return doc;
}

const short = (t: string) => t.slice(0, 12);

/** 进程关闭/任务中止：不提交任何结果，原样抛出（重启后阶段重跑）。 */
function rethrowIfAborted(signal: AbortSignal, err: unknown): void {
  if (signal.aborted) throw err;
}

/**
 * reply 阶段（两类任务共用）：compose 只读 TicketDoc 得到正文与图片。
 * 发送成功 → 记录正文并以 completed 结束；失败 → 票据仍 pending 且未到上限则推进 attempt 重试，否则 failed 结束。
 */
async function replyPhase<S extends { phase: string }>(
  deps: TaskDeps,
  task: RunningTask<TaskInput, ReplyCheckpoint, TaskResult>,
  runtime: Runtime<S>,
  context: Context,
  compose: (doc: Readonly<TicketState>) => { text: string; images: string[] },
): Promise<void> {
  const attempt = task.state.checkpoint.attempt ?? 0;
  if (attempt > 0) await runtime.sleep(runtime.now() + (deps.replyRetryDelayMs ?? 2000) * attempt, context);
  const doc = await ticketDoc(runtime, context);
  const { text, images } = compose(doc);
  // 已 sent 的票据仍可调用 reply（幂等返回 already_sent，不会再发）；其余非 pending / 已放弃 → 不发送
  const blocked = await blockedReason(deps, runtime, context, doc.ticket);
  if (blocked && blocked !== "ticket sent") return failBlocked(runtime, context, doc.ticket, blocked, "reply");
  try {
    const res = await deps.getBridge().reply(doc.ticket, text, images, { signal: runtime.signal });
    await cleanupTicketWorkdir(deps, doc.ticket);
    await runtime.commit(async (tx) => {
      const d = await tx.doc(TicketDoc, runtime.conversationId);
      d.replyText = text;
      d.replyImages = images.length;
      d.replyMessageId = res.message_id;
      return { status: "terminal", outcome: { status: "completed", result: { sent: true, already_sent: res.already_sent } } };
    }, context);
    trace.event(doc.ticket, "reply_sent", { detail: { message_id: res.message_id, images: images.length, reply: text,
      already_sent: res.already_sent, truncated: text.includes("…（内容过长，已截断）"), terminal: false } });
    log.info("reply sent", { ticket: short(doc.ticket), message_id: res.message_id, already_sent: res.already_sent, images: images.length });
  } catch (err) {
    rethrowIfAborted(runtime.signal, err);
    const rec = await deps.getBridge().getTicket(doc.ticket).catch(() => undefined);
    const retry = rec?.status === "pending" && attempt + 1 < MAX_REPLY_ATTEMPTS;
    log.warn(retry ? "reply failed before sending, will retry" : "reply failed", {
      ticket: short(doc.ticket),
      attempt,
      ticket_status: rec?.status ?? "unknown",
      error: (err as Error).message,
    });
    if (!retry) await cleanupTicketWorkdir(deps, doc.ticket);
    await runtime.commit(async () =>
      retry
        ? { status: "running", checkpoint: { phase: "reply", attempt: attempt + 1 } as S & ReplyCheckpoint }
        : { status: "terminal", outcome: { status: "failed", error: { message: `reply failed: ${(err as Error).message.slice(0, 200)}` } } },
    context);
  }
}

/**
 * 回复阶段结束（发出或放弃）后删除票据工作目录 ${ticketsDir}/<ticket>（codex-last.txt 等）。
 * 此时后端结果已在 TicketDoc 里，重跑不会再用到它；图片目录另行管理，不在这里删除。
 */
async function cleanupTicketWorkdir(deps: TaskDeps, ticket: string, uploads: readonly RemoteUpload[] = []): Promise<void> {
  await ingestImageEvents(ticketImageDir(deps.imagesDir, ticket));
  if (uploads.length) {
    if (!deps.imageBackend.clearReferences) throw new Error('生图后端不支持参考图覆盖');
    await deps.imageBackend.clearReferences(uploads);
  }
  await recoverRemoteUploads(ticketImageDir(deps.imagesDir, ticket), deps.imageBackend);
  if (!deps.ticketsDir) return;
  try {
    await fs.rm(ticketWorkDir(deps.ticketsDir, ticket), { recursive: true, force: true });
  } catch (err) {
    log.warn("ticket dir cleanup failed", { ticket: short(ticket), error: (err as Error).message });
  }
}

/**
 * 外部副作用（提交生图、codex 回合、发送回复）之前的检查：派发条目存在且未 givenUp / failed，票据仍 pending。
 * 返回不能继续的原因；undefined 表示可以继续。
 */
async function blockedReason(deps: TaskDeps, runtime: AnyRuntime, context: Context, ticket: string): Promise<string | undefined> {
  runtime.signal.throwIfAborted();
  const entry = (await runtime.snapshot(DispatchDoc, context))?.pending[ticket];
  if (!entry) return "dispatch entry missing";
  if (entry.givenUp) return "dispatch gave up";
  if (entry.state === "failed") return "dispatch marked failed";
  const rec = await deps.getBridge().getTicket(ticket).catch(() => undefined);
  if (rec === undefined) return "ticket unreadable";
  if (rec === null) return "ticket missing";
  return rec.status === "pending" ? undefined : `ticket ${rec.status}`;
}

/** 不能继续：不产生任何副作用，以 failed 结束。 */
async function failBlocked(runtime: AnyRuntime, context: Context, ticket: string, reason: string, phase: string): Promise<void> {
  log.warn("task phase skipped: ticket no longer live", { ticket: short(ticket), phase, reason });
  await runtime.commit(async () => ({ status: "terminal", outcome: { status: "failed", error: { message: `skipped ${phase}: ${reason}` } } }), context);
}

async function abortTask(runtime: AnyRuntime, context: Context): Promise<void> {
  await runtime.commit(async () => ({ status: "terminal", outcome: { status: "aborted" } }), context);
}

/** 每次实际恢复/尝试均有独立阶段起止；检查点自身保持原事务。 */
function phases<S extends { phase: string }>(handlers: TaskDefinition<TaskInput, S, TaskResult, object>["phases"]): typeof handlers {
  return Object.fromEntries(Object.entries(handlers).map(([phase, handler]) => [phase, async (task: RunningTask<TaskInput, S, TaskResult>, runtime: Runtime<S>, context: Context) => {
    const fn = handler as (task: RunningTask<TaskInput, S, TaskResult>, runtime: Runtime<S>, context: Context) => Promise<void>;
    const doc = await ticketDoc(runtime, context);
    const stage = phase === "lateImages" ? "late_images" : phase === "postprocess" ? "postprocess" : "phase:" + phase;
    return trace.span(doc.ticket, stage, () => fn(task, runtime, context), { checkpoint: task.state.checkpoint });
  }])) as typeof handlers;
}

export function createTasks(deps: TaskDeps) {
  type ImageRuntime = Runtime<ImageCheckpoint>;

  /** 两条路径共用收取延期上限、退避和按参数计算的预算。 */
  function nextCollectWindow(now: number, used: number, options: Parameters<typeof imageTimeoutMs>[0], err: unknown) {
    if (classifyImageError(err) !== 'timeout' || used >= (deps.imageCollectExtensions ?? 2)) return undefined;
    const nextCollectAt = now + (deps.imageCollectDelayMs ?? 1000);
    return { extensions: used + 1, nextCollectAt,
      deadline: nextCollectAt + imageTimeoutMs(options, deps.imageTimeoutCapMs ?? 300_000) };
  }

  /** 提交 ComfyUI 任务；成功后立即把 {prompt_id, backend, submits} 与 collect 检查点同一提交写入。 */
  async function submitJob(runtime: ImageRuntime, context: Context, doc: Readonly<TicketState>, prevSubmits: number): Promise<void> {
    const blocked = await blockedReason(deps, runtime, context, doc.ticket);
    if (blocked) return failBlocked(runtime, context, doc.ticket, blocked, "submit");
    const intent = {
      attempt: prevSubmits + 1, filenamePrefix: imageFilenamePrefix(doc.ticket, prevSubmits + 1),
      count: doc.imageOptions?.count ?? doc.submitIntent?.count ?? 1,
      imageOptions: doc.imageOptions ?? { prompt: doc.prompt ?? "" },
      referenceSubfolder: doc.ticket,
    };
    // 网络提交前先保存意图，并清除旧 prompt_id；崩溃时即使仍在 collect 检查点也能恢复对账。
    await runtime.commit(async (tx) => {
      const d = await tx.doc(TicketDoc, runtime.conversationId);
      d.submitIntent = intent;
      d.remoteUploads = referenceUploads(intent.imageOptions, intent.referenceSubfolder);
      delete d.imageJob;
      return undefined;
    }, context);
    const started = Date.now();
    let promptId: string;
    try {
      runtime.signal.throwIfAborted();
      if (doc.image_error) throw new Error(doc.image_error);
      const opts = doc.imageOptions ?? { prompt: doc.prompt ?? '' };
      const refs = await validateReferences(opts.reference_images ?? [], doc.source_images ?? [],
        path.join(path.dirname(deps.imagesDir), 'incoming', doc.ticket));
      promptId = await observeImages(deps.imageBackend, doc.ticket).submit({ ...opts, reference_images: refs }, intent, runtime.signal);
    } catch (err) {
      rethrowIfAborted(runtime.signal, err);
      const failure = classifyImageError(err);
      log.warn("image submit failed", { ticket: short(doc.ticket), ms: Date.now() - started, failure, error: (err as Error).message });
      await runtime.commit(async (tx) => {
        (await tx.doc(TicketDoc, runtime.conversationId)).imageResult = { ok: false, failure, ...((err as Error).message.startsWith("透明输出未启用：") ? { message: (err as Error).message } : {}) };
        return { status: "running", checkpoint: { phase: "reply", attempt: 0 } };
      }, context);
      return;
    }
    await runtime.commit(async (tx) => {
      (await tx.doc(TicketDoc, runtime.conversationId)).imageJob = { prompt_id: promptId, backend: deps.imageBackend.name, submits: prevSubmits + 1, status: "running", deadline: runtime.now() + imageTimeoutMs(intent.imageOptions, deps.imageTimeoutCapMs ?? 300_000), extensions: 0 };
      return { status: "running", checkpoint: { phase: "collect", submits: prevSubmits + 1 } };
    }, context);
    log.info("image job recorded", { ticket: short(doc.ticket), prompt_id: promptId, submits: prevSubmits + 1 });
  }

  async function clearRemote(runtime: ImageRuntime, context: Context): Promise<void> {
    const doc = await ticketDoc(runtime, context);
    if (doc.remoteUploads?.length) {
      if (!deps.imageBackend.clearReferences) throw new Error('生图后端不支持参考图覆盖');
      await deps.imageBackend.clearReferences(doc.remoteUploads);
      await runtime.commit(async tx => { (await tx.doc(TicketDoc, runtime.conversationId)).remoteUploads = []; return undefined; }, context);
    }
  }

  async function extendCollect(runtime: ImageRuntime, context: Context, doc: Readonly<TicketState>, err: unknown): Promise<boolean> {
    if (!doc.imageJob) return false;
    const window = nextCollectWindow(runtime.now(), doc.imageJob.extensions ?? 0, doc.imageOptions ?? { prompt: doc.prompt ?? 'recovery' }, err);
    if (!window) return false;
    await runtime.commit(async tx => {
      const d = await tx.doc(TicketDoc, runtime.conversationId);
      d.imageJob = { ...doc.imageJob!, status: 'running', ...window };
      return { status: 'running', checkpoint: { phase: 'collect', extensions: window.extensions } };
    }, context);
    return true;
  }

  async function finishImage(runtime: ImageRuntime, context: Context, result: ImageResult): Promise<void> {
    await runtime.commit(async (tx) => {
      (await tx.doc(TicketDoc, runtime.conversationId)).imageResult = result;
      return undefined;
    }, context);
    await clearRemote(runtime, context);
    await runtime.commit(async () => {
      return { status: "running", checkpoint: { phase: "reply", attempt: 0 } };
    }, context);
  }

  /** 提交响应丢失 / unknown 都走同一条对账路径。只有明确查无输出才消耗下一次提交。 */
  async function reconcileJob(runtime: ImageRuntime, context: Context, doc: Readonly<TicketState>): Promise<void> {
    const blocked = await blockedReason(deps, runtime, context, doc.ticket);
    if (blocked) return failBlocked(runtime, context, doc.ticket, blocked, "reconcile");
    const attempt = doc.submitIntent?.attempt ?? doc.imageJob?.submits ?? 1;
    const intent = doc.submitIntent ?? { attempt, filenamePrefix: imageFilenamePrefix(doc.ticket, attempt) };
    const dir = ticketImageDir(deps.imagesDir, doc.ticket);
    try {
      const recovered = await observeImages(deps.imageBackend, doc.ticket).reconcile(intent, dir, runtime.signal, step =>
        runtime.commit(async tx => {
          const d = await tx.doc(TicketDoc, runtime.conversationId);
          d.imageReconciliation = [...(d.imageReconciliation ?? []), { ...step, attempt }];
          if (step.prompt_id) d.imageJob = {
            ...(d.imageJob?.prompt_id === step.prompt_id ? d.imageJob : {}),
            prompt_id: step.prompt_id, backend: deps.imageBackend.name, submits: attempt, status: 'running',
          };
          return undefined;
        }, context),
      );
      if (recovered.images.length || recovered.prompt_id) {
        const images = await collectNewImages(dir, new Set());
        await finishImage(runtime, context, images.length ? { ok: true, images } : { ok: false, failure: "failed" });
        return;
      }
    } catch (err) {
      rethrowIfAborted(runtime.signal, err);
      if (await extendCollect(runtime, context, await ticketDoc(runtime, context), err)) return;
      // 无法查询或下载不等于没有运行；结束为失败，绝不据此重新提交。
      await finishImage(runtime, context, { ok: false, failure: classifyImageError(err) });
      return;
    }
    if (attempt < MAX_IMAGE_SUBMITS) {
      await submitJob(runtime, context, doc, attempt);
    } else {
      await finishImage(runtime, context, { ok: false, failure: "failed" });
    }
  }

  async function submitPhase(runtime: ImageRuntime, context: Context): Promise<void> {
    const doc = await ticketDoc(runtime, context);
    if (!doc.imageResult && doc.route === "image" && doc.prompt) {
      if (doc.imageJob) {
        // 已提交过（检查点停在旧阶段）：只收取，不再提交
        await runtime.commit(async () => ({ status: "running", checkpoint: { phase: "collect" } }), context);
        return;
      }
      if (doc.submitIntent) {
        await reconcileJob(runtime, context, doc);
        return;
      }
      // 旧的单阶段生图在写出图片后、提交前崩溃：直接复用目录里的图片
      const existing = await collectNewImages(ticketImageDir(deps.imagesDir, doc.ticket), new Set());
      if (existing.length) {
        log.warn("reusing images already in the ticket dir", { ticket: short(doc.ticket), images: existing.length });
        await runtime.commit(async (tx) => {
          (await tx.doc(TicketDoc, runtime.conversationId)).imageResult = { ok: true, images: existing };
          return { status: "running", checkpoint: { phase: "reply", attempt: 0 } };
        }, context);
        return;
      }
      await submitJob(runtime, context, doc, 0);
      return;
    }
    await runtime.commit(async () => ({ status: "running", checkpoint: { phase: "reply", attempt: 0 } }), context);
  }

  const ImageTask = defineTask<TaskInput, ImageCheckpoint, TaskResult>({
    name: IMAGE_TASK,
    version: 1,
    initial: () => ({ phase: "submit" }),
    phases: phases<ImageCheckpoint>({
      submit: (task, runtime, context) => submitPhase(runtime, context),
      // v3 初版的单阶段生图（已落盘的旧任务可能停在这里）：按 submit 处理
      generate: (task, runtime, context) => submitPhase(runtime, context),
      collect: async (_task, runtime, context) => {
        const doc = await ticketDoc(runtime, context);
        const job = doc.imageJob;
        if (job?.nextCollectAt) await runtime.sleep(job.nextCollectAt, context);
        let result: ImageResult | undefined = doc.imageResult;
        if (!result && !job) return submitPhase(runtime, context);
        if (!result && job) {
          const dir = ticketImageDir(deps.imagesDir, doc.ticket);
          const started = Date.now();
          try {
            // 上次运行已把输出下载进票据目录、但在提交前崩溃：直接复用（fetch 只是本地下载，不会重新生图）
            let images = await collectNewImages(dir, new Set());
            if (images.length) {
              log.warn("reusing images already in the ticket dir", { ticket: short(doc.ticket), images: images.length });
            } else {
              const remaining = (job.deadline ?? runtime.now() + imageTimeoutMs(doc.imageOptions ?? { prompt: doc.prompt ?? 'recovery' }, deps.imageTimeoutCapMs ?? 300_000)) - runtime.now();
              if (remaining <= 0) throw new Error('生图超时');
              await observeImages(deps.imageBackend, doc.ticket).collect(job.prompt_id, dir, AbortSignal.any([runtime.signal, AbortSignal.timeout(Math.ceil(remaining))]), doc.imageOptions);
              images = await collectNewImages(dir, new Set());
            }
            // 只认票据目录里通过校验（大小、魔数）的新图片；一张都没有即生图失败
            result = images.length ? { ok: true, images } : { ok: false, failure: "failed" };
            if (images.length) log.info("image generated", { ticket: short(doc.ticket), backend: deps.imageBackend.name, prompt_id: job.prompt_id, ms: Date.now() - started, images: images.length });
            else log.warn("image job produced no valid images", { ticket: short(doc.ticket), prompt_id: job.prompt_id });
          } catch (err) {
            rethrowIfAborted(runtime.signal, err);
            if (err instanceof UnknownJobError && doc.prompt) {
              log.warn("comfy job unknown; reconciling output prefix before retry", { ticket: short(doc.ticket), prompt_id: job.prompt_id, submits: job.submits });
              await reconcileJob(runtime, context, doc);
              return;
            }
            if (await extendCollect(runtime, context, doc, err)) return;
            const failure = err instanceof UnknownJobError ? "failed" : classifyImageError(err);
            log.warn("image generation failed", { ticket: short(doc.ticket), prompt_id: job.prompt_id, ms: Date.now() - started, failure, error: (err as Error).message });
            result = { ok: false, failure };
          }
        }
        await finishImage(runtime, context, result ?? { ok: false, failure: "failed" });
      },
      reply: async (task, runtime, context) => {
        await clearRemote(runtime, context);
        return replyPhase(deps, task, runtime, context, (doc) => {
          if (doc.route !== "image" || !doc.prompt) return { text: IMAGE_USAGE_REPLY, images: [] };
          const r = doc.imageResult;
          if (r?.ok) return { text: IMAGE_SUCCESS_REPLY, images: [...r.images] };
          return { text: r ? r.message ?? IMAGE_FAILURE_REPLIES[r.failure] : IMAGE_FAILURE_REPLIES.failed, images: [] };
        });
      },
    }),
    abort: (_task, runtime, context) => abortTask(runtime, context),
  });

  const AgentTask = defineTask<TaskInput, AgentCheckpoint, TaskResult>({
    name: AGENT_TASK,
    version: 1,
    initial: () => ({ phase: "handle" }),
    phases: phases<AgentCheckpoint>({
      handle: async (_task, runtime, context) => {
        const doc = await ticketDoc(runtime, context);
        let result: AgentResult | undefined = doc.agentResult;
        if (!result) {
          const source = doc.source;
          const scope = source.type === "group" ? `group:${source.group_id}` : `private:${source.user_id}`;
          let quote: { nickname: string; text: string } | undefined;
          if (doc.replyTo && deps.store) {
            try {
              const hit = deps.store.message({ kind: "scope", scope }, doc.replyTo);
              if (hit) quote = { nickname: hit.row.is_self ? "我" : hit.row.nickname || hit.row.user_id, text: hit.row.text };
            } catch (err) {
              log.warn("quote lookup failed", { ticket: short(doc.ticket), error: err });
            }
          }
          const blocked = await blockedReason(deps, runtime, context, doc.ticket);
          if (blocked) return failBlocked(runtime, context, doc.ticket, blocked, "handle");
          let backendName = "unknown";
          const started = Date.now();
          try {
            if (doc.image_error) throw new Error(doc.image_error);
            const backend = deps.backends.select(scope);
            backendName = backend.name;
            const res = await trace.span(doc.ticket, "backend:" + backend.name, () => backend.handle(
              {
                ticket: doc.ticket,
                scope,
                access: accessToString(accessForSource(source, deps.owner)),
                threadKey: backend.name === "pi" && threadKeyForSource(source, deps.owner) !== "owner"
                  ? scope as `group:${string}` | `private:${string}` : threadKeyForSource(source, deps.owner),
                source: { ...source },
                text: doc.text,
                images: doc.source_images ?? [],
                ...(doc.time ? { time: doc.time } : {}),
                ...(quote ? { quote } : {}),
              },
              {
                signal: runtime.signal,
                onEvent: (e) => log.debug("agent backend event", { ticket: short(doc.ticket), ...e }),
                piTurn: doc.piTurn,
                persistPiTurn: state => runtime.commit(async tx => {
                  (await tx.doc(TicketDoc, runtime.conversationId)).piTurn = { ...state };
                  return undefined;
                }, context),
                ...(doc.codexTurn ? { turn: doc.codexTurn } : {}),
                // 启动外部回合之前落盘"回合已开始"（不推进检查点）
                persistTurn: (state) =>
                  runtime.commit(async (tx) => {
                    (await tx.doc(TicketDoc, runtime.conversationId)).codexTurn = { ...state };
                    return undefined;
                  }, context),
              },
            ), { backend: backend.name }, res => ({ raw_reply: res.text, images: res.images }));
            result = { ok: true, backend: backendName, text: res.text, images: [...(res.images ?? [])].slice(0, 4) };
          } catch (err) {
            rethrowIfAborted(runtime.signal, err);
            const failure = err instanceof BackendTimeoutError ? "timeout" : "failed";
            log.warn("agent backend failed", { ticket: short(doc.ticket), backend: backendName, ms: Date.now() - started, failure, error: (err as Error).message });
            result = { ok: false, backend: backendName, failure };
          }
        }
        await runtime.commit(async (tx) => {
          (await tx.doc(TicketDoc, runtime.conversationId)).agentResult = result;
          return { status: "running", checkpoint: { phase: "lateImages" } };
        }, context);
      },
      lateImages: async (_task, runtime, context) => {
        let doc = await ticketDoc(runtime, context);
        await ingestImageEvents(ticketImageDir(deps.imagesDir, doc.ticket));
        const blocked = await blockedReason(deps, runtime, context, doc.ticket);
        if (blocked) return failBlocked(runtime, context, doc.ticket, blocked, "lateImages");
        const dir = ticketImageDir(deps.imagesDir, doc.ticket);
        if (doc.lateImageJobs === undefined) {
          let jobs: Awaited<ReturnType<typeof readPendingImages>>;
          try { jobs = await readPendingImages(dir); }
          catch (err) {
            if (!(err instanceof PendingImageMarkerError)) throw err;
            await runtime.commit(async tx => {
              (await tx.doc(TicketDoc, runtime.conversationId)).attachmentFailure = true;
              return undefined;
            }, context);
            await quarantinePendingImages(dir);
            jobs = [];
          }
          await runtime.commit(async tx => {
            (await tx.doc(TicketDoc, runtime.conversationId)).lateImageJobs = jobs.map(job => ({ ...job, extensions: 0 }));
            return undefined;
          }, context);
          doc = await ticketDoc(runtime, context);
        }
        for (const [index, job] of doc.lateImageJobs!.entries()) {
          if (job.result) continue;
          const deadline = job.deadline ?? runtime.now() + imageTimeoutMs(job.options, deps.imageTimeoutCapMs ?? 300_000);
          if (job.deadline === undefined) await runtime.commit(async tx => {
            (await tx.doc(TicketDoc, runtime.conversationId)).lateImageJobs![index]!.deadline = deadline;
            return undefined;
          }, context);
          if (job.nextCollectAt) await runtime.sleep(job.nextCollectAt, context);
          let result: ImageResult;
          try {
            runtime.signal.throwIfAborted();
            const callDir = await pendingCallDir(dir, job.callDir);
            let manifest = await readImageFiles(callDir);
            const complete = manifest?.length && (await Promise.all(manifest.map(f =>
              f.downloaded && validImageFile(path.join(callDir, f.filename))))).every(Boolean);
            if (job.status !== "done" && !complete) {
              const remaining = deadline - runtime.now();
              if (remaining <= 0) throw new Error("生图超时");
              const signal = AbortSignal.any([runtime.signal, AbortSignal.timeout(Math.ceil(remaining))]);
              try {
                if (!job.prompt_id) throw new UnknownJobError("intent");
                await observeImages(deps.imageBackend, doc.ticket).collect(job.prompt_id, callDir, signal, job.options);
              } catch (err) {
                rethrowIfAborted(runtime.signal, err);
                if (!(err instanceof UnknownJobError)) throw err;
                await observeImages(deps.imageBackend, doc.ticket).reconcile({ filenamePrefix: job.filenamePrefix,
                  count: job.options.count ?? 1, imageOptions: job.options }, callDir, signal, step =>
                  runtime.commit(async tx => {
                    const j = (await tx.doc(TicketDoc, runtime.conversationId)).lateImageJobs![index]!;
                    j.reconciliation = [...(j.reconciliation ?? []), step];
                    if (step.prompt_id) j.prompt_id = step.prompt_id;
                    return undefined;
                  }, context));
              }
            }
            const images = await collectNewImages(callDir, new Set());
            manifest = await readImageFiles(callDir) ?? await prepareImageFiles(callDir, images.map(f => path.basename(f)));
            if (!manifest.length || manifest.some(f => !f.downloaded) ||
                !(await Promise.all(manifest.map(f => validImageFile(path.join(callDir, f.filename))))).every(Boolean)) {
              throw new Error("图片批次尚未完整收取");
            }
            result = { ok: true, images: await Promise.all(manifest.map(f => fs.realpath(path.join(callDir, f.filename)))) };
            await runtime.commit(async tx => {
              const j = (await tx.doc(TicketDoc, runtime.conversationId)).lateImageJobs![index]!;
              j.files = manifest; j.remoteTerminal = true; j.status = "done";
              return undefined;
            }, context);
          } catch (err) {
            rethrowIfAborted(runtime.signal, err);
            const window = nextCollectWindow(runtime.now(), job.extensions, job.options, err);
            if (window) {
              await runtime.commit(async tx => {
                Object.assign((await tx.doc(TicketDoc, runtime.conversationId)).lateImageJobs![index]!, window);
                return { status: "running", checkpoint: { phase: "lateImages", job: index, extensions: window.extensions } };
              }, context);
              return;
            }
            result = { ok: false, failure: classifyImageError(err) };
          }
          await runtime.commit(async tx => {
            (await tx.doc(TicketDoc, runtime.conversationId)).lateImageJobs![index]!.result = result;
            return undefined;
          }, context);
        }
        // 保留未确认远端终态的条目，票据清理也不得提前覆盖参考图。
        doc = await ticketDoc(runtime, context);
        if (!doc.attachmentFailure) {
          for (const job of doc.lateImageJobs ?? []) {
            const { deadline: _deadline, extensions: _extensions, nextCollectAt: _next, reconciliation: _steps, result: _result, files: _files, ...marker } = job;
            await savePendingImage(dir, marker);
          }
          await recoverRemoteUploads(dir, deps.imageBackend);
          if (doc.lateImageJobs?.every(j => j.status === "done")) await fs.rm(path.join(dir, PENDING_IMAGE_JOBS), { force: true });
        }
        await runtime.commit(async () => ({ status: "running", checkpoint: { phase: "postprocess" } }), context);
      },
      postprocess: async (_task, runtime, context) => {
        const doc = await ticketDoc(runtime, context);
        let draft = doc.replyDraft;
        if (draft === undefined && doc.agentResult?.ok) {
          const mode: ReplyMode = doc.agentResult.backend === "codex" ? deps.codexReplyMode : "direct";
          const out = await postprocessReply(doc.agentResult.text, {
            ticket: doc.ticket,
            mode,
            ...(deps.models ? { models: deps.models } : {}),
            ...(deps.relayModel ? { model: deps.relayModel } : {}),
            signal: runtime.signal,
          });
          rethrowIfAborted(runtime.signal, new Error("aborted"));
          trace.event(doc.ticket, "postprocess", { detail: { raw_reply: doc.agentResult.text, sent_text: out.text, relayed: out.relayed,
            truncated: out.text.includes("…（内容过长，已截断）") } });
          draft = out.text;
        }
        await runtime.commit(async (tx) => {
          if (draft !== undefined) (await tx.doc(TicketDoc, runtime.conversationId)).replyDraft = draft;
          return { status: "running", checkpoint: { phase: "reply", attempt: 0 } };
        }, context);
      },
      reply: (task, runtime, context) =>
        replyPhase(deps, task, runtime, context, (doc) => {
          const r = doc.agentResult;
          let text = r?.ok ? doc.replyDraft ?? sanitizeReply(r.text) : r ? AGENT_FAILURE_REPLIES[r.failure] : FALLBACK_REPLY;
          const late = doc.lateImageJobs ?? [];
          if (doc.attachmentFailure) text = sanitizeReply(text.slice(0, 3900) + "\n附件收取失败，部分图片未能发送。");
          if (late.some(job => job.result && !job.result.ok)) text = sanitizeReply(text.slice(0, 3900) + "\n有一张图生成超时未能发送");
          const images = [...new Set([...(r?.ok ? r.images : []), ...late.flatMap(job => job.result?.ok ? job.result.images : [])])].slice(0, 4);
          return { text, images };
        }),
    }),
    abort: (_task, runtime, context) => abortTask(runtime, context),
  });

  return { ImageTask, AgentTask, cleanupTicketWorkdir: (ticket: string, uploads?: readonly RemoteUpload[]) => cleanupTicketWorkdir(deps, ticket, uploads) };
}

export type CsTasks = ReturnType<typeof createTasks>;

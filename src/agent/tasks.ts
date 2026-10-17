/**
 * 每条 QQ 消息的 durable 任务（pi-durable defineTask，设计 §4.2 / §4.3）：
 * - 生图任务 `cs.image`：submit（提交 ComfyUI，prompt_id 立即落盘）→ collect（按 prompt_id 等待并下载）→ reply
 * - agent 任务 `cs.agent`：handle → postprocess → reply
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
import { defineTask, type RunningTask, type TaskRuntime } from "@earendil-works/pi-durable";
import { accessForSource, accessToString } from "../context/access.js";
import type { ContextStore } from "../context/store.js";
import type { QQBridge } from "../qq/types.js";
import { log } from "../log.js";
import { threadKeyForSource } from "./codex-runner.js";
import { TicketDoc, type AgentResult, type ImageResult, type TicketState } from "./docs.js";
import { collectNewImages } from "./image-collect.js";
import { classifyImageError, ticketImageDir, UnknownJobError, type ImageBackend } from "./image-gen.js";
import { AGENT_FAILURE_REPLIES, FALLBACK_REPLY, IMAGE_FAILURE_REPLIES, IMAGE_SUCCESS_REPLY } from "./replies.js";
import { postprocessReply, sanitizeReply, type ReplyMode } from "./reply-postprocess.js";
import { IMAGE_USAGE_REPLY } from "./router.js";
import { BackendTimeoutError } from "./backends/types.js";
import type { BackendSelector } from "./backends/select.js";

export const IMAGE_TASK = "cs.image";
export const AGENT_TASK = "cs.agent";
/** reply 阶段在票据仍 pending 时的最多尝试次数 */
export const MAX_REPLY_ATTEMPTS = 3;

export type TaskInput = { ticket: string };
export type TaskResult = { sent: boolean; already_sent?: boolean };
type ReplyCheckpoint = { phase: "reply"; attempt: number };
/** generate 为 v3 初版的单阶段生图（仅为兼容已落盘的旧任务），按 submit 处理 */
export type ImageCheckpoint = { phase: "submit" } | { phase: "generate" } | { phase: "collect"; submits?: number } | ReplyCheckpoint;
/** 同一票据最多提交 ComfyUI 任务的次数（服务端丢失任务时重新提交 1 次） */
export const MAX_IMAGE_SUBMITS = 2;
export type AgentCheckpoint = { phase: "handle" } | { phase: "postprocess" } | ReplyCheckpoint;

export interface TaskDeps {
  getBridge: () => Pick<QQBridge, "reply" | "getTicket">;
  imageBackend: Pick<ImageBackend, "submit" | "collect" | "name">;
  imagesDir: string;
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
  try {
    const res = await deps.getBridge().reply(doc.ticket, text, images);
    await runtime.commit(async (tx) => {
      const d = await tx.doc(TicketDoc, runtime.conversationId);
      d.replyText = text;
      d.replyImages = images.length;
      d.replyMessageId = res.message_id;
      return { status: "terminal", outcome: { status: "completed", result: { sent: true, already_sent: res.already_sent } } };
    }, context);
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
    await runtime.commit(async () =>
      retry
        ? { status: "running", checkpoint: { phase: "reply", attempt: attempt + 1 } as S & ReplyCheckpoint }
        : { status: "terminal", outcome: { status: "failed", error: { message: `reply failed: ${(err as Error).message.slice(0, 200)}` } } },
    context);
  }
}

async function abortTask(runtime: AnyRuntime, context: Context): Promise<void> {
  await runtime.commit(async () => ({ status: "terminal", outcome: { status: "aborted" } }), context);
}

export function createTasks(deps: TaskDeps) {
  type ImageRuntime = Runtime<ImageCheckpoint>;

  /** 提交 ComfyUI 任务；成功后立即把 {prompt_id, backend, submits} 与 collect 检查点同一提交写入。 */
  async function submitJob(runtime: ImageRuntime, context: Context, doc: Readonly<TicketState>, prevSubmits: number): Promise<void> {
    const started = Date.now();
    let promptId: string;
    try {
      promptId = await deps.imageBackend.submit(doc.prompt ?? "", runtime.signal);
    } catch (err) {
      rethrowIfAborted(runtime.signal, err);
      const failure = classifyImageError(err);
      log.warn("image submit failed", { ticket: short(doc.ticket), ms: Date.now() - started, failure, error: (err as Error).message });
      await runtime.commit(async (tx) => {
        (await tx.doc(TicketDoc, runtime.conversationId)).imageResult = { ok: false, failure };
        return { status: "running", checkpoint: { phase: "reply", attempt: 0 } };
      }, context);
      return;
    }
    await runtime.commit(async (tx) => {
      (await tx.doc(TicketDoc, runtime.conversationId)).imageJob = { prompt_id: promptId, backend: deps.imageBackend.name, submits: prevSubmits + 1 };
      return { status: "running", checkpoint: { phase: "collect", submits: prevSubmits + 1 } };
    }, context);
    log.info("image job recorded", { ticket: short(doc.ticket), prompt_id: promptId, submits: prevSubmits + 1 });
  }

  async function submitPhase(runtime: ImageRuntime, context: Context): Promise<void> {
    const doc = await ticketDoc(runtime, context);
    if (!doc.imageResult && doc.route === "image" && doc.prompt) {
      if (doc.imageJob) {
        // 已提交过（检查点停在旧阶段）：只收取，不再提交
        await runtime.commit(async () => ({ status: "running", checkpoint: { phase: "collect" } }), context);
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
    phases: {
      submit: (task, runtime, context) => submitPhase(runtime, context),
      // v3 初版的单阶段生图（已落盘的旧任务可能停在这里）：按 submit 处理
      generate: (task, runtime, context) => submitPhase(runtime, context),
      collect: async (_task, runtime, context) => {
        const doc = await ticketDoc(runtime, context);
        const job = doc.imageJob;
        let result: ImageResult | undefined = doc.imageResult;
        if (!result && job) {
          const dir = ticketImageDir(deps.imagesDir, doc.ticket);
          const started = Date.now();
          try {
            // 上次运行已把输出下载进票据目录、但在提交前崩溃：直接复用（fetch 只是本地下载，不会重新生图）
            let images = await collectNewImages(dir, new Set());
            if (images.length) {
              log.warn("reusing images already in the ticket dir", { ticket: short(doc.ticket), images: images.length });
            } else {
              await deps.imageBackend.collect(job.prompt_id, dir, runtime.signal);
              images = await collectNewImages(dir, new Set());
            }
            // 只认票据目录里通过校验（大小、魔数）的新图片；一张都没有即生图失败
            result = images.length ? { ok: true, images } : { ok: false, failure: "failed" };
            if (images.length) log.info("image generated", { ticket: short(doc.ticket), backend: deps.imageBackend.name, prompt_id: job.prompt_id, ms: Date.now() - started, images: images.length });
            else log.warn("image job produced no valid images", { ticket: short(doc.ticket), prompt_id: job.prompt_id });
          } catch (err) {
            rethrowIfAborted(runtime.signal, err);
            if (err instanceof UnknownJobError && job.submits < MAX_IMAGE_SUBMITS && doc.prompt) {
              // 服务端丢失了该任务（例如 ComfyUI 重启）：重新提交一次，提交次数随 prompt_id 一起落盘
              log.warn("comfy job unknown to the server, resubmitting once", { ticket: short(doc.ticket), prompt_id: job.prompt_id, submits: job.submits });
              await submitJob(runtime, context, doc, job.submits);
              return;
            }
            const failure = err instanceof UnknownJobError ? "failed" : classifyImageError(err);
            log.warn("image generation failed", { ticket: short(doc.ticket), prompt_id: job.prompt_id, ms: Date.now() - started, failure, error: (err as Error).message });
            result = { ok: false, failure };
          }
        }
        await runtime.commit(async (tx) => {
          if (result) (await tx.doc(TicketDoc, runtime.conversationId)).imageResult = result;
          return { status: "running", checkpoint: { phase: "reply", attempt: 0 } };
        }, context);
      },
      reply: (task, runtime, context) =>
        replyPhase(deps, task, runtime, context, (doc) => {
          if (doc.route !== "image" || !doc.prompt) return { text: IMAGE_USAGE_REPLY, images: [] };
          const r = doc.imageResult;
          if (r?.ok) return { text: IMAGE_SUCCESS_REPLY, images: [...r.images] };
          return { text: r ? IMAGE_FAILURE_REPLIES[r.failure] : IMAGE_FAILURE_REPLIES.failed, images: [] };
        }),
    },
    abort: (_task, runtime, context) => abortTask(runtime, context),
  });

  const AgentTask = defineTask<TaskInput, AgentCheckpoint, TaskResult>({
    name: AGENT_TASK,
    version: 1,
    initial: () => ({ phase: "handle" }),
    phases: {
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
          let backendName = "unknown";
          const started = Date.now();
          try {
            const backend = deps.backends.select(scope);
            backendName = backend.name;
            const res = await backend.handle(
              {
                ticket: doc.ticket,
                scope,
                access: accessToString(accessForSource(source, deps.owner)),
                threadKey: threadKeyForSource(source, deps.owner),
                source: { ...source },
                text: doc.text,
                ...(doc.time ? { time: doc.time } : {}),
                ...(quote ? { quote } : {}),
              },
              { signal: runtime.signal, onEvent: (e) => log.debug("agent backend event", { ticket: short(doc.ticket), ...e }) },
            );
            result = { ok: true, backend: backendName, text: res.text, images: [...(res.images ?? [])].slice(0, 4) };
          } catch (err) {
            rethrowIfAborted(runtime.signal, err);
            const failure = err instanceof BackendTimeoutError ? "timeout" : "failed";
            log.warn("agent backend failed", { ticket: short(doc.ticket), backend: backendName, ms: Date.now() - started, failure, error: (err as Error).message });
            result = { ok: false, backend: backendName, failure };
          }
        }
        const next = result.ok ? ({ phase: "postprocess" } as const) : ({ phase: "reply", attempt: 0 } as const);
        await runtime.commit(async (tx) => {
          (await tx.doc(TicketDoc, runtime.conversationId)).agentResult = result;
          return { status: "running", checkpoint: next };
        }, context);
      },
      postprocess: async (_task, runtime, context) => {
        const doc = await ticketDoc(runtime, context);
        let draft = doc.replyDraft;
        if (draft === undefined && doc.agentResult?.ok) {
          const mode: ReplyMode = doc.agentResult.backend === "codex" ? deps.codexReplyMode : "direct";
          const out = await postprocessReply(doc.agentResult.text, {
            mode,
            ...(deps.models ? { models: deps.models } : {}),
            ...(deps.relayModel ? { model: deps.relayModel } : {}),
            signal: runtime.signal,
          });
          rethrowIfAborted(runtime.signal, new Error("aborted"));
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
          if (r?.ok) return { text: doc.replyDraft ?? sanitizeReply(r.text), images: [...r.images] };
          return { text: r ? AGENT_FAILURE_REPLIES[r.failure] : FALLBACK_REPLY, images: [] };
        }),
    },
    abort: (_task, runtime, context) => abortTask(runtime, context),
  });

  return { ImageTask, AgentTask };
}

export type CsTasks = ReturnType<typeof createTasks>;

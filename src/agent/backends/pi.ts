import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT, withAbortSignal, awaitWithContext } from "@earendil-works/chord/context";
import type { Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { AssistantEntry, createRegistry, defineDoc, Harness, type Conversation, type ConversationId, type ModelRef, type Storage, type Submission } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { buildCodexPrompt } from "../codex-runner.js";
import { collectNewImages } from "../image-collect.js";
import { ticketImageDir } from "../image-gen.js";
import { validateReferences } from "../image-references.js";
import { createPiExtension, type PiToolsOptions } from "../pi-tools/index.js";
import { PiRequestDoc } from "../pi-tools/request.js";
import { PiPromptLoader } from "../pi-tools/prompt.js";
import { parseAccess } from "../../context/access.js";
import { log } from "../../log.js";
import { BackendTimeoutError, type AgentBackend, type AgentRequest, type AgentHandleContext, type AgentResponse } from "./types.js";

const context = BACKGROUND_CONTEXT;
/** 与会话创建同事务提交，JSON 映射是原子写出的运维镜像，丢失时可从 SQLite 重建。 */
const PiThreadsDoc = defineDoc<Record<string, number | null>>({
  kind: "cs.pi.threads", version: 1, scope: "session", initial: () => ({}),
});

const PiMigrationDoc = defineDoc<{ sharedRetired: boolean }>({
  kind: "cs.pi.migration", version: 1, scope: "session", initial: () => ({ sharedRetired: false }),
});

export interface PiBackendOptions extends Omit<PiToolsOptions, "getHarness"> {
  models: Models;
  model: ModelRef;
  thinkingLevel: ModelThinkingLevel;
  timeoutMs?: number;
  reserveTokens?: number;
  backgroundTokens?: number;
  /** 测试用内存或自定义持久化存储；生产使用 DATA_DIR/pi.sqlite。 */
  storage?: Storage;
}

export class PiBackend implements AgentBackend {
  readonly name = "pi" as const;
  private readonly tails = new Map<string, Promise<unknown>>();
  private closing = false;
  private constructor(readonly harness: Harness, private readonly opts: PiBackendOptions) {}

  static async open(opts: PiBackendOptions): Promise<PiBackend> {
    await new PiPromptLoader(opts.dataDir).read();
    const registry = createRegistry();
    let harness!: Harness;
    registry.install(createPiExtension({ ...opts, getHarness: () => harness }));
    harness = await Harness.open(opts.storage ?? await openNodeSqliteStorage(path.join(opts.dataDir, "pi.sqlite")), {
      models: opts.models, registry,
      settings: { toolExecution: "sequential", retry: { maxRetries: 2 }, compaction: {
        enabled: true,
        ...(opts.reserveTokens !== undefined ? { reserveTokens: opts.reserveTokens } : {}),
        ...(opts.backgroundTokens !== undefined ? { backgroundTokens: opts.backgroundTokens } : {}),
      } },
      onReport: err => log.warn("pi harness report", { error: err instanceof Error ? err.message : String(err) }),
    }, context);
    const backend = new PiBackend(harness, opts);
    try {
      const retired = await harness.commit(async tx => {
        const threads = await tx.doc(PiThreadsDoc);
        const migration = await tx.doc(PiMigrationDoc);
        if (threads.shared == null || migration.sharedRetired) return false;
        migration.sharedRetired = true;
        return true;
      }, context);
      if (retired) log.warn("pi shared conversation retired; mixed history will never be reused");
      await backend.persistThreads();
      // 先把恢复中的回合纳入对应线程锁，再允许新请求；沿用已落盘截止时间。
      for (const [key, id] of Object.entries(await backend.readThreadIds())) {
        const conv = await harness.conversation(id as ConversationId, context);
        if (!conv) throw new Error("pi 线程映射指向不存在的会话");
        const request = await harness.snapshot(PiRequestDoc, conv.id, context);
        if (request?.ticket) {
          const recovery = backend.lock(key, () => backend.bounded(conv, request.deadline, undefined,
            ctx => conv.waitForIdle(ctx)));
          void recovery.catch(err => log.warn("pi recovery ended", { thread: key, error: err instanceof Error ? err.message : String(err) }));
        }
      }
      return backend;
    } catch (err) { await harness.close(context); throw err; }
  }

  private lock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    const tail = run.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.finally(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return run;
  }

  async readThreadIds(): Promise<Record<string, number>> {
    const doc = await this.harness.snapshot(PiThreadsDoc, context);
    return Object.fromEntries(Object.entries(doc ?? {}).filter((entry): entry is [string, number] =>
      entry[0] !== "shared" && entry[1] !== null));
  }

  async threadHealth(): Promise<{ count: number; keys: string[] }> {
    const keys = Object.keys(await this.readThreadIds()).sort();
    return { count: keys.length, keys };
  }

  private async persistThreads(): Promise<void> {
    const file = path.join(this.opts.dataDir, "pi-threads.json");
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(await this.readThreadIds()) + "\n", { encoding: "utf8", flag: "wx" });
      await fs.rename(tmp, file);
    } finally { await fs.unlink(tmp).catch(() => undefined); }
  }

  private async conversation(key: string): Promise<Conversation> {
    // 仅创建和 JSON 写回用短全局锁，模型回合按 owner 或 scope 分别串行。
    return this.lock("mapping", async () => {
      const id = (await this.readThreadIds())[key];
      const agent = { model: this.opts.model, thinkingLevel: this.opts.thinkingLevel };
      if (id !== undefined) {
        const conv = await this.harness.conversation(id as ConversationId, context);
        if (!conv) throw new Error("pi 会话不存在");
        await conv.configure(agent, context);
        await this.persistThreads();
        return conv;
      }
      const conv = await this.harness.createConversation({ ownership: { kind: "ownerless" }, agent,
        init: async (tx, conversationId) => { (await tx.doc(PiThreadsDoc))[key] = conversationId; },
      }, context);
      await this.persistThreads();
      return conv;
    });
  }

  /** 超时或调用方取消后，必须等实际回合中止才释放线程锁。取消等待本身不会取消 pi 工作。 */
  private async bounded<T>(conv: Conversation, deadline: number, signal: AbortSignal | undefined,
    work: (ctx: ReturnType<typeof withAbortSignal>) => Promise<T>): Promise<T> {
    const timer = new AbortController();
    const timeout = setTimeout(() => timer.abort(new BackendTimeoutError("处理超时，请稍后再试。")), Math.max(1, deadline - Date.now()));
    const joined = AbortSignal.any([timer.signal, ...(signal ? [signal] : [])]);
    try { return await work(withAbortSignal(joined, context)); }
    catch (err) {
      if (joined.aborted && !this.closing) {
        await conv.abort(context, { background: true });
        if (timer.signal.aborted) throw new BackendTimeoutError("处理超时，请稍后再试。");
      }
      throw err;
    } finally { clearTimeout(timeout); }
  }

  handle(req: AgentRequest, ctx: AgentHandleContext): Promise<AgentResponse> {
    if (this.closing) return Promise.reject(new Error("pi 后端正在关闭"));
    // 排队取消只取消此等待；队列槽位仍保留，轮到后检查 signal，不启动新回合。
    const key = req.threadKey === "owner" ? "owner" : req.scope;
    return awaitWithContext(this.lock(key, () => this.turn({ ...req, threadKey: key as AgentRequest["threadKey"] }, ctx)), withAbortSignal(ctx.signal, context));
  }

  private async turn(req: AgentRequest, ctx: AgentHandleContext): Promise<AgentResponse> {
    ctx.signal.throwIfAborted();
    if (this.closing) throw new Error("pi 后端正在关闭");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(req.ticket)) throw new Error("非法票据");
    if (!parseAccess(req.access) || (req.threadKey !== "owner" && req.access !== req.scope)) throw new Error("非法访问范围");
    const conv = await this.conversation(req.threadKey);
    let requestId = ctx.piTurn?.requestId ?? req.ticket;
    const known = await conv.commit(tx => tx.submissionByRequest(conv.id, requestId), context);
    let deadline = Date.now() + (this.opts.timeoutMs ?? 300_000);
    if (!known) {
      await conv.waitForIdle(withAbortSignal(ctx.signal, context));
      ctx.signal.throwIfAborted();
      const images = await validateReferences(req.images ?? [], req.images ?? [], path.join(this.opts.dataDir, "incoming", req.ticket));
      const content = buildCodexPrompt(req.source, req.text, { time: req.time, quote: req.quote }) +
        (images.length ? "\n[本轮参考图]\n" + images.join("\n") : "");
      await conv.commit(async tx => {
        const doc = await tx.doc(PiRequestDoc, conv.id);
        // 崩溃可能发生在绑定与 submit 之间，同票据继续沿用计数、截止时间与原文。
        if (doc.ticket === req.ticket) { deadline = doc.deadline; return; }
        Object.assign(doc, { ticket: req.ticket, access: req.access, images, content, deadline, calls: {} });
      }, context);
    } else if (known.status !== "done" && known.status !== "unanswered") {
      const bound = await this.harness.snapshot(PiRequestDoc, conv.id, context);
      if (bound?.ticket !== req.ticket) throw new Error("pi 在途请求与绑定不一致");
      deadline = bound.deadline;
    }
    ctx.onEvent({ type: "pi_start", thread: req.threadKey, conversation: conv.id });
    return this.bounded(conv, deadline, ctx.signal, async waitContext => {
      const bound = await this.harness.snapshot(PiRequestDoc, conv.id, context);
      waitContext.abortSignal?.throwIfAborted();
      // requestId 直接使用 ticket；即使已有回执，也通过 submit 的持久化去重复用。
      let submission: Submission = await conv.submit({ type: "input", requestId,
        content: bound?.ticket === req.ticket ? bound.content : req.text, whenBusy: "reject" }, context);
      let settled = await submission.wait(waitContext);
      // 仅恢复既有的 aborted 回执；本次新发生的用户取消/超时不重提。
      if (known?.status === "unanswered" && settled.status === "unanswered" && settled.reason === "aborted" &&
          (ctx.piTurn?.retries ?? 0) < 1) {
        if (bound?.ticket !== req.ticket) throw new Error("pi 恢复请求与绑定不一致");
        requestId = req.ticket + "#r" + ((ctx.piTurn?.retries ?? 0) + 1);
        await ctx.persistPiTurn?.({ requestId, retries: (ctx.piTurn?.retries ?? 0) + 1 });
        await conv.commit(async tx => { (await tx.doc(PiRequestDoc, conv.id)).deadline = deadline; }, context);
        waitContext.abortSignal?.throwIfAborted();
        submission = await conv.submit({ type: "input", requestId, content: bound.content, whenBusy: "reject" }, context);
        settled = await submission.wait(waitContext);
      }
      if (settled.status !== "done" || settled.type !== "input") throw new Error("pi 未能完成本次请求，请稍后再试。");
      const answer = await conv.commit(tx => tx.entry(AssistantEntry, settled.answer), context);
      const text = answer?.model?.flatMap(m => m.role === "assistant" ? m.content.filter(c => c.type === "text").map(c => c.text) : []).join("").trim();
      if (!text) throw new Error("pi 返回了空回复");
      const images = await collectNewImages(ticketImageDir(path.join(this.opts.dataDir, "images"), req.ticket), new Set());
      ctx.onEvent({ type: "pi_done", thread: req.threadKey, conversation: conv.id, images: images.length });
      return { text, images };
    });
  }

  /** 必须在关闭票据 harness 前调用，使其 signal 只停止等待、不终结 pi submission。 */
  beginShutdown(): void { this.closing = true; }

  async close(): Promise<void> {
    this.beginShutdown();
    await this.harness.close(context);
    await Promise.allSettled([...this.tails.values()]);
  }
}

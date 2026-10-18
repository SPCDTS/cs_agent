import type { ContextUsageStore } from "../context-usage.js";
import { PiContextObserver, piContextCapacity } from "../pi-context-usage.js";
import { readThreadArchive, writeThreadArchive, THREAD_ARCHIVE_LIMIT } from "../thread-archive.js";
import { trace } from "../../obs/trace.js";
import type { PiConversation, PiEntryPage, PiSessionSource } from "../../obs/sessions/pi-adapter.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT, withAbortSignal, awaitWithContext } from "@earendil-works/chord/context";
import type { Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { AssistantEntry, createRegistry, defineDoc, Harness, ROOT_CONVERSATION_ID, watchEvents, type Conversation, type ConversationId, type Cursor, type EntryId, type ModelRef, type Storage, type Submission } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { buildCodexPrompt } from "../codex-runner.js";
import { collectNewImages } from "../image-collect.js";
import { ticketImageDir } from "../image-gen.js";
import { validateReferences } from "../image-references.js";
import { codingEnvironment, codingTools } from "../pi-tools/coding.js";
import { createPiExtension, type PiToolsOptions } from "../pi-tools/index.js";
import { PiRequestDoc } from "../pi-tools/request.js";
import { PiPromptLoader } from "../pi-tools/prompt.js";
import { isScope, parseAccess } from "../../context/access.js";
import { log } from "../../log.js";
import { BackendTimeoutError, type AgentBackend, type AgentRequest, type AgentHandleContext, type AgentResponse } from "./types.js";

const context = BACKGROUND_CONTEXT;
/** 与会话创建同事务提交，JSON 映射是原子写出的运维镜像，丢失时可从 SQLite 重建。 */
const PiThreadsDoc = defineDoc<Record<string, number | null>>({
  kind: "cs.pi.threads", version: 1, scope: "session", initial: () => ({}),
});

type PiArchiveRow = { key: string; conversation: number; archived_at: string; reason: string };
/** 重置归档与映射在同一次 SQLite 提交中写入；JSONL 仅是可重建镜像。 */
export const PiThreadsArchiveDoc = defineDoc<{ imported: boolean; rows: PiArchiveRow[] }>({
  kind: "cs.pi.threads.archive", version: 1, scope: "session",
  initial: () => ({ imported: false, rows: [] }),
});

const PiMigrationDoc = defineDoc<{ sharedRetired: boolean }>({
  kind: "cs.pi.migration", version: 1, scope: "session", initial: () => ({ sharedRetired: false }),
});

export interface PiBackendOptions extends Omit<PiToolsOptions, "getHarness"> {
  models: Models;
  contextUsage?: ContextUsageStore;
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
  private readonly contextObservers = new Map<string, PiContextObserver>();
  readonly sessionSource: PiSessionSource;
  private constructor(readonly harness: Harness, private readonly opts: PiBackendOptions) {
    this.sessionSource = {
      listConversations: () => this.listObservedConversations(),
      entries: async (id, cursor, limit = 256): Promise<PiEntryPage> => {
        const conv = await this.observedConversation(id);
        const after = cursor === undefined ? 0 : this.observedId(cursor);
        const page = await conv.entries({ order: "ascending", minEntryId: (after + 1) as EntryId },
          Math.max(1, Math.min(1000, Math.floor(limit))), undefined, context);
        return { items: page.items, cursor: page.items.length ? String(page.items.at(-1)!.id) : cursor, hasMore: !!page.next };
      },
      context: async (id, at) => (await this.observedConversation(id)).context(context,
        at === undefined ? undefined : { at: this.observedId(at) as EntryId }),
      subscribe: async (id, cb) => {
        const conv = await this.observedConversation(id);
        const stream = await watchEvents(this.harness, conv.id, context);
        stream.start(async events => {
          if (events.some(event => event.type === "entry_appended" || event.type === "message_end" || event.type === "snapshot")) cb();
        });
        return () => { void stream.stop().catch(() => undefined); };
      },
    };
  }

  /** 面板只通过公开 API 读取会话；禁止把请求中的 ID 当文件路径。 */
  private observedId(id: string): number {
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error("非法 Pi 会话或条目 ID");
    return Number(id);
  }

  private async observedConversation(id: string): Promise<Conversation> {
    const conv = await this.harness.conversation(this.observedId(id) as ConversationId, context);
    if (!conv) throw new Error("Pi 会话不存在");
    return conv;
  }

  private async listObservedConversations(): Promise<PiConversation[]> {
    const [threads, archive] = await Promise.all([
      this.harness.snapshot(PiThreadsDoc, context), this.harness.snapshot(PiThreadsArchiveDoc, context),
    ]);
    const active = new Map(Object.entries(threads ?? {}).filter(([key, id]) => key !== "shared" && id !== null)
      .map(([key, id]) => [id, key]));
    const archived = new Map((archive?.rows ?? []).map(row => [row.conversation, row.key]));
    if (threads?.shared != null) archived.set(threads.shared, "shared");
    const result: PiConversation[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await this.harness.commit(tx => tx.scanConversations({ order: "ascending" }, 256, cursor), context);
      for (const row of page.items) {
        if (row.id === ROOT_CONVERSATION_ID) continue;
        const key = active.get(row.id) ?? archived.get(row.id);
        result.push({ id: String(row.id), label: key ?? String(row.id), status: active.has(row.id) ? "active" : "archived",
          ...(key ? { scope: key } : {}) });
      }
      cursor = page.next;
    } while (cursor);
    return result;
  }

  static async open(opts: PiBackendOptions): Promise<PiBackend> {
    await new PiPromptLoader(opts.dataDir).read();
    const registry = createRegistry();
    let harness!: Harness;
    registry.install(await codingTools());
    registry.install(createPiExtension({ ...opts, getHarness: () => harness }));
    harness = await Harness.open(opts.storage ?? await openNodeSqliteStorage(path.join(opts.dataDir, "pi.sqlite")), {
      models: opts.models, registry,
      env: async (target, ctx) => {
        const threads = await target.read.snapshot(PiThreadsDoc, ctx);
        const key = Object.entries(threads ?? {}).find(([, id]) => id === target.conversationId)?.[0];
        if (!key || key === "shared") return undefined;
        // 每次工具调用/恢复均从已提交文档重建身份；不从 handle 闭包或全局变量取当前票据。
        const request = await target.read.snapshot(PiRequestDoc, target.conversationId, ctx);
        if (!request?.ticket) return undefined;
        return codingEnvironment({ dataDir: opts.dataDir, key, request, store: opts.store });
      },
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
      await backend.importArchive();
      await backend.persistMirrors();
      // 先把恢复中的回合纳入对应线程锁，再允许新请求；沿用已落盘截止时间。
      const threadIds = await backend.readThreadIds();
      // 映射先提交、用量尚在防抖窗口就退出时，启动时修复已重置线程的旧用量。
      for (const old of opts.contextUsage?.all() ?? []) {
        if (old.backend === "pi" && threadIds[old.key] === undefined &&
          (old.turns || old.usedTokens || old.cachedTokens || old.lastCompactionAt)) opts.contextUsage?.reset("pi", old.key);
      }
      let backfilled = 0;
      for (const [key, id] of Object.entries(threadIds)) {
        const conv = await harness.conversation(id as ConversationId, context);
        if (!conv) throw new Error("pi 线程映射指向不存在的会话");
        if (await backend.observeContext(key, conv)) backfilled++;
        const request = await harness.snapshot(PiRequestDoc, conv.id, context);
        if (request?.ticket) {
          const recovery = backend.lock(key, () => backend.bounded(conv, request.deadline, undefined,
            ctx => conv.waitForIdle(ctx)));
          void recovery.catch(err => log.warn("pi recovery ended", { thread: key, error: err instanceof Error ? err.message : String(err) }));
        }
      }
      log.info("context usage backfilled", { backend: "pi", checked: Object.keys(threadIds).length, backfilled });
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

  private get archiveFile(): string { return path.join(this.opts.dataDir, "pi-threads-archive.jsonl"); }

  private async importArchive(): Promise<void> {
    if ((await this.harness.snapshot(PiThreadsArchiveDoc, context))?.imported) return;
    const rows = await readThreadArchive<PiArchiveRow>(this.archiveFile);
    await this.harness.commit(async tx => {
      const archive = await tx.doc(PiThreadsArchiveDoc);
      if (!archive.imported) { archive.rows = rows.slice(-THREAD_ARCHIVE_LIMIT); archive.imported = true; }
    }, context);
  }

  /** 提交后的镜像失败只告警；下次启动或映射操作重写，不撤销已提交的重置。 */
  private async persistMirrors(): Promise<void> {
    for (const write of [() => this.persistThreads(), async () => {
      const archive = await this.harness.snapshot(PiThreadsArchiveDoc, context);
      await writeThreadArchive(this.archiveFile, archive?.rows ?? []);
    }]) {
      try { await write(); }
      catch (err) { log.warn("pi thread mirror stale; will retry", { error: err instanceof Error ? err.message : String(err) }); }
    }
  }

  private async observeContext(key: string, conv: Conversation, ticket?: string): Promise<boolean> {
    if (!this.opts.contextUsage || this.contextObservers.has(key)) return false;
    const model = this.opts.models.getModel(this.opts.model.provider, this.opts.model.modelId);
    if (!model) throw new Error("pi 上下文窗口缺少模型定义");
    const observer = await PiContextObserver.open(this.harness, conv, key, this.opts.contextUsage,
      piContextCapacity(model.contextWindow, this.opts.reserveTokens, this.opts.backgroundTokens), ticket);
    this.contextObservers.set(key, observer);
    return observer.backfilled;
  }

  /** 重置后重新查当前映射，不能从已归档的会话恢复旧占用。 */
  private async backfillResetContext(key: string): Promise<void> {
    const id = (await this.readThreadIds())[key];
    let backfilled = false;
    if (id === undefined) this.opts.contextUsage?.reset("pi", key);
    else {
      const conv = await this.harness.conversation(id as ConversationId, context);
      if (conv) backfilled = await this.observeContext(key, conv);
    }
    log.info("context usage backfilled", { backend: "pi", checked: id === undefined ? 0 : 1, backfilled: Number(backfilled) });
  }

  private async conversation(key: string, ticket: string): Promise<Conversation> {
    // 仅创建和 JSON 写回用短全局锁，模型回合按 owner 或 scope 分别串行。
    return this.lock("mapping", async () => {
      const id = (await this.readThreadIds())[key];
      const agent = { model: this.opts.model, thinkingLevel: this.opts.thinkingLevel };
      if (id !== undefined) {
        const conv = await this.harness.conversation(id as ConversationId, context);
        if (!conv) throw new Error("pi 会话不存在");
        await conv.configure(agent, context);
        await this.observeContext(key, conv, ticket);
        await this.persistMirrors();
        return conv;
      }
      const conv = await this.harness.createConversation({ ownership: { kind: "ownerless" }, agent,
        init: async (tx, conversationId) => { (await tx.doc(PiThreadsDoc))[key] = conversationId; },
      }, context);
      this.opts.contextUsage?.reset("pi", key, ticket);
      await this.observeContext(key, conv, ticket);
      await this.persistMirrors();
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
    // 实时视图：同一会话键上排队等待的时间（开始/结束各一条，不改变锁语义）
    const queued = Date.now();
    trace.event(req.ticket, "thread_wait", { status: "started", detail: { backend: "pi", conversation_key: key } });
    return awaitWithContext(this.lock(key, () => {
      trace.event(req.ticket, "thread_wait", { durationMs: Date.now() - queued, detail: { backend: "pi", conversation_key: key } });
      return this.turn({ ...req, threadKey: key as AgentRequest["threadKey"] }, ctx);
    }), withAbortSignal(ctx.signal, context));
  }

  private async turn(req: AgentRequest, ctx: AgentHandleContext): Promise<AgentResponse> {
    ctx.signal.throwIfAborted();
    if (this.closing) throw new Error("pi 后端正在关闭");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(req.ticket)) throw new Error("非法票据");
    if (!parseAccess(req.access) || (req.threadKey !== "owner" && req.access !== req.scope)) throw new Error("非法访问范围");
    const conv = await this.conversation(req.threadKey, req.ticket);
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
        Object.assign(doc, { ticket: req.ticket, access: req.access, images, content, deadline, calls: {}, imageJobs: [] });
      }, context);
    } else if (known.status !== "done" && known.status !== "unanswered") {
      const bound = await this.harness.snapshot(PiRequestDoc, conv.id, context);
      if (bound?.ticket !== req.ticket) throw new Error("pi 在途请求与绑定不一致");
      deadline = bound.deadline;
    }
    trace.event(req.ticket, "dispatched", { detail: { backend: "pi", conversation_key: req.threadKey, conversation: conv.id, recovered: !!known } });
    if (known) trace.event(req.ticket, "recovered", { detail: { backend: "pi", request_id: requestId } });
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
        // 先续期再保存后缀；后缀已落盘但 submit 前再次退出时，不能沿用旧的过期期限。
        await conv.commit(async tx => { (await tx.doc(PiRequestDoc, conv.id)).deadline = deadline; }, context);
        await ctx.persistPiTurn?.({ requestId, retries: (ctx.piTurn?.retries ?? 0) + 1 });
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

  /**
   * 面板"重置会话"：排在该键的回合之后（不打断进行中的回合），映射置空、旧会话保留在 SQLite 中作归档，
   * 归档记录与映射同事务提交，再重写 JSON/JSONL 镜像；下一条消息新建会话。
   */
  resetThread(key: string, reason = "dashboard"): Promise<number | null> {
    if (key !== "owner" && !isScope(key)) return Promise.reject(new Error("非法会话键"));
    return this.lock(key, () => this.lock("mapping", async () => {
      const id = (await this.readThreadIds())[key] ?? null;
      if (id === null) { await this.backfillResetContext(key); return null; }
      await this.harness.commit(async tx => {
        (await tx.doc(PiThreadsDoc))[key] = null;
        const archive = await tx.doc(PiThreadsArchiveDoc);
        archive.rows.push({ key, conversation: id, archived_at: new Date().toISOString(), reason });
        archive.rows = archive.rows.slice(-THREAD_ARCHIVE_LIMIT);
      }, context);
      await this.persistMirrors();
      await this.contextObservers.get(key)?.close();
      this.contextObservers.delete(key);
      await this.backfillResetContext(key);
      log.info("pi conversation reset", { conversation_key: key, conversation: id, reason });
      return id;
    }));
  }

  /** 必须在关闭票据 harness 前调用，使其 signal 只停止等待、不终结 pi submission。 */
  beginShutdown(): void { this.closing = true; }

  async close(): Promise<void> {
    this.beginShutdown();
    await Promise.all([...this.contextObservers.values()].map(observer => observer.close()));
    this.contextObservers.clear();
    await this.harness.close(context);
    await Promise.allSettled([...this.tails.values()]);
  }
}

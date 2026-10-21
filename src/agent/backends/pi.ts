import type { ContextUsageStore } from "../context-usage.js";
import { PiContextObserver, piContextCapacity, refreshPiCompactionUsage } from "../pi-context-usage.js";
import { readThreadArchive, writeThreadArchive, THREAD_ARCHIVE_LIMIT } from "../thread-archive.js";
import { trace } from "../../shared/trace.js";
import type { PiConversation, PiEntryPage, PiSessionSource } from "./pi-session-types.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { clampThinkingLevel, type Models, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, Harness, LiveDoc, ROOT_CONVERSATION_ID, watchEvents, type AgentEvent, type AgentEventStream, type Conversation, type ConversationId, type Cursor, type EntryId, type ModelRef, type Storage, type SubmissionId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { codingEnvironment, codingTools } from "../pi-tools/coding.js";
import { createPiExtension, type PiToolsOptions } from "../pi-tools/index.js";
import { createPiScheduleExtensions } from "../pi-tools/schedule.js";
import { createPiImExtensions } from "../pi-tools/im.js";
import { PiChildDoc, traceKey, type PiCallBinding } from "../pi-tools/request.js";
import { createSubagentExtension, isSubagentReportRequest, type SubagentOptions } from "../pi-tools/subagent.js";
import { PiPromptLoader } from "../pi-tools/prompt.js";
import { isScope } from "../../context/access.js";
import { log } from "../../shared/log.js";
import { isOwner, type OwnerIds } from "../../shared/owners.js";
import type { InboundRecord, TurnBinding } from "../../channel/types.js";
import type { HostCallbacks, InputRef, ThreadAdapter, ThreadKey, TurnContext, TurnStatus } from "../host/types.js";
import type { RenderedInputs } from "../inbox.js";
import type { TicketSettings } from "./types.js";

/**
 * pi 后端（设计 §6）：每个会话键一个常驻的 pi-durable 会话，回合 = pi 的一次 run（从输入到最终回答）。
 * 1. 开一轮：首条输入 whenBusy=followUp（requestId = 入站键，重放取回同一提交），同批其余输入 steer 并入；
 *    会话恰好已有 run（宿主尚未看到的唤醒回合）时，输入全部 steer 并入那次 run，回合 id 取那次 run。
 *    回合 id = `pi:<会话>:<run 首条输入的提交 id>`；该提交结束（done / unanswered）即回合结束。
 * 2. 插话：适配器自己判断回合是否仍在（回合首条提交未结束）才 steer，否则返回 no_active_turn 由宿主排队；
 *    判断与提交之间回合恰好结束时，插话会自己开一次 run，按唤醒回合回报（身份只会更严格）。
 * 3. 唤醒：会话事件流里出现宿主不知道的 run（子 agent 汇报 follow-up）→ onTurnStarted(backend)；
 *    宿主有回合进行中时出现的 run 视为并入该回合（同一会话一次只有一个回合）。
 * 4. 没有单轮时限、没有每轮工具配额；中止只来自面板"停止"与看门狗（连同子 agent 一起停）。
 * 5. 工具身份在调用时由 binding() 从宿主求出（§7.3）；子会话由 initChild 写入父会话键，固定为唤醒身份。
 * 6. 恢复：pi-durable 持久化 run 与子 agent，重启后回合续跑；bind 宿主 → 宿主恢复（recoverTurn）→ attach 事件流并恢复调度。
 */

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

/** 宿主侧提供的输入读取与本轮绑定（Inbox）。 */
export interface PiTurns {
  binding(threadKey: string): TurnBinding;
  records(inputs: readonly Pick<InputRef, "inboundKey">[]): InboundRecord[];
  render(records: readonly InboundRecord[]): Promise<RenderedInputs>;
}

export interface PiBackendOptions extends Omit<PiToolsOptions, "getHarness" | "workspaceDir" | "binding"> {
  models: Models;
  /** 运维指引根目录；Pi 工具路径策略仍整体禁读此 Codex 工作区。 */
  workspaceDir?: string;
  contextUsage?: ContextUsageStore;
  model: ModelRef;
  currentModel?: () => ModelRef;
  thinkingLevel: ModelThinkingLevel;
  reserveTokens?: number;
  backgroundTokens?: number;
  /** 测试用内存或自定义持久化存储；生产使用 DATA_DIR/pi.sqlite。 */
  storage?: Storage;
  turns: PiTurns;
  owners?: OwnerIds | (() => OwnerIds);
  /** 子 agent 扩展的选项；false 不安装 */
  subagent?: Partial<Omit<SubagentOptions, "getHarness" | "initChild">> | false;
}

type ActiveTurn = { turnId: string; first: SubmissionId; owner: "host" | "backend" };
type ThreadState = { conv: ConversationId; active?: ActiveTurn; stream?: AgentEventStream };

export const piTurnId = (conv: ConversationId | number, first: SubmissionId | number) => `pi:${Number(conv)}:${Number(first)}`;
function parseTurnId(turnId: string): { conv: ConversationId; first: SubmissionId } | undefined {
  const m = /^pi:([1-9]\d*):([1-9]\d*)$/.exec(turnId);
  return m ? { conv: Number(m[1]) as unknown as ConversationId, first: Number(m[2]) as unknown as SubmissionId } : undefined;
}

export class PiBackend implements ThreadAdapter {
  readonly name = "pi" as const;
  private readonly tails = new Map<string, Promise<unknown>>();
  private closing = false;
  private host?: HostCallbacks;
  private attached = false;
  private readonly threads = new Map<string, ThreadState>();
  /** 会话 id → 会话键（映射文档的内存反查） */
  private readonly keys = new Map<number, string>();
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

  /** 打开 harness 但不恢复调度：宿主恢复回合（recoverTurn）后由 attach() 接上事件流并恢复调度。 */
  static async open(opts: PiBackendOptions): Promise<PiBackend> {
    await new PiPromptLoader(opts.dataDir).read();
    const workspaceDir = opts.workspaceDir ?? process.env.WORKSPACE_DIR ?? "/workspace";
    const registry = createRegistry();
    let harness!: Harness;
    let backend!: PiBackend;
    const binding = (id: number) => backend.binding(id);
    const coding = await codingTools(), extension = createPiExtension({ ...opts, workspaceDir, getHarness: () => harness, binding });
    const im = createPiImExtensions({ ...opts, binding });
    const schedule = createPiScheduleExtensions(binding, opts.scheduleTools);
    const subagent = opts.subagent === false ? undefined : createSubagentExtension({ ...opts.subagent, getHarness: () => harness,
      // 子会话与父会话共用会话键（工作区、附件目录），身份固定为唤醒。
      initChild: async (tx, parent, child) => {
        const threads = await tx.doc(PiThreadsDoc);
        const key = Object.entries(threads).find(([, id]) => id === Number(parent))?.[0];
        if (!key || key === "shared") throw new Error("子 agent 只能由会话线程派出");
        Object.assign(await tx.doc(PiChildDoc, child), { threadKey: key, parent: Number(parent) });
      } });
    for (const item of [coding, extension, ...Object.values(im), ...Object.values(schedule), ...(subagent ? [subagent] : [])]) registry.install(item);
    const storage = opts.storage ?? await openNodeSqliteStorage(path.join(opts.dataDir, "pi.sqlite"));
    harness = await Harness.open(storage, {
      models: opts.models, registry,
      env: async target => {
        // 每次工具调用/恢复均从宿主当前回合重建身份；不从闭包或全局变量取当前回合。
        const bound = await backend.binding(Number(target.conversationId));
        if (!bound) return undefined;
        return codingEnvironment({ dataDir: opts.dataDir, workspaceDir, skillsDir: opts.skillsDir, key: bound.threadKey,
          request: { access: bound.access, senderIsOwner: bound.senderIsOwner, inputs: bound.inputs }, store: opts.store });
      },
      settings: { extensions: [coding, extension, im.basic, ...(subagent ? [subagent] : [])], toolExecution: "sequential", retry: { maxRetries: 2 }, compaction: {
        enabled: true,
        ...(opts.reserveTokens !== undefined ? { reserveTokens: opts.reserveTokens } : {}),
        ...(opts.backgroundTokens !== undefined ? { backgroundTokens: opts.backgroundTokens } : {}),
      } },
      onReport: err => log.warn("pi harness report", { error: err instanceof Error ? err.message : String(err) }),
    }, context);
    backend = new PiBackend(harness, { ...opts, storage });
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
        backend.keys.set(id, key);
        if (await backend.observeContext(key, conv)) backfilled++;
      }
      log.info("context usage backfilled", { backend: "pi", checked: Object.keys(threadIds).length, backfilled });
      return backend;
    } catch (err) { await harness.close(context); throw err; }
  }

  /** 宿主创建后立即绑定（恢复回合的结束事件需要回报）。 */
  bind(host: HostCallbacks): void { this.host = host; }

  /**
   * 宿主恢复之后调用一次：接上每个会话的事件流（宿主不知道的 run 按唤醒回合回报），再恢复 pi 调度。
   */
  async attach(): Promise<void> {
    this.attached = true;
    for (const [key, id] of Object.entries(await this.readThreadIds())) {
      await this.serial(key, async () => { await this.watchThread(key, id as ConversationId); });
    }
    this.harness.resume();
  }

  /** 会话键串行：开轮、插话、事件处理与回合结束互不交错。 */
  private serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    const tail = run.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.finally(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return run;
  }

  private owners(): OwnerIds { return typeof this.opts.owners === "function" ? this.opts.owners() : this.opts.owners; }

  /**
   * 工具调用时的本轮绑定（§7.3）：主会话取宿主当前回合；子会话固定为唤醒身份。
   * 读取范围：本人是 owner（或 owner 线程的唤醒回合）为 all，其余为本会话。
   */
  async binding(conversationId: number): Promise<PiCallBinding | undefined> {
    let threadKey = this.keys.get(conversationId), child = false;
    if (!threadKey) {
      const mapped = Object.entries(await this.harness.snapshot(PiThreadsDoc, context) ?? {}).find(([, id]) => id === conversationId)?.[0];
      if (mapped && mapped !== "shared") { threadKey = mapped; this.keys.set(conversationId, mapped); }
    }
    if (!threadKey) {
      const doc = await this.harness.snapshot(PiChildDoc, conversationId as ConversationId, context);
      if (doc?.threadKey) { threadKey = doc.threadKey; child = true; }
    }
    if (!threadKey) return undefined;
    const turn = this.opts.turns.binding(threadKey);
    const identity = child ? { kind: "wake" as const } : turn.identity;
    const person = identity.kind === "user" ? identity.sender : identity.kind === "scheduled" ? identity.creator : undefined;
    const ownerPerson = !!person && isOwner(this.owners(), person);
    const inputs = child ? [] : turn.inputs;
    const images = inputs.length ? this.opts.turns.records(inputs.map(inboundKey => ({ inboundKey }))).flatMap(rec => rec.images) : [];
    return { ...turn, identity, inputs, images, child, ...(child ? { turnId: undefined } : {}),
      access: ownerPerson || (!person && threadKey === "owner") ? "all" : turn.scope, senderIsOwner: ownerPerson && !child };
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

  private async observeContext(key: string, conv: Conversation, ref = this.opts.model): Promise<boolean> {
    if (!this.opts.contextUsage) return false;
    const model = this.opts.models.getModel(ref.provider, ref.modelId);
    if (!model) throw new Error("pi 上下文窗口缺少模型定义");
    const capacity = piContextCapacity(model.contextWindow, this.opts.reserveTokens, this.opts.backgroundTokens);
    const existing = this.contextObservers.get(key);
    if (existing) {
      existing.updateCapacity(capacity);
      this.opts.contextUsage.ensure("pi", key, capacity);
      return false;
    }
    const observer = await PiContextObserver.open(this.harness, conv, key, this.opts.contextUsage, this.opts.storage!,
      capacity, undefined, () => { const active = this.threads.get(key)?.active; return active ? "turn:" + active.turnId : undefined; });
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

  /** 会话键 → 常驻会话（首次使用时创建）；每轮按设置快照配置模型与思考档位。 */
  private async conversation(key: string, settings?: TicketSettings): Promise<Conversation> {
    // 仅创建和 JSON 写回用短全局锁。
    return this.serial("mapping", async () => {
      const id = (await this.readThreadIds())[key];
      // 没有快照（唤醒回合等）时读取当前模型。
      let ref = settings?.piModel !== undefined ? this.opts.currentModel?.() ?? { ...this.opts.model, modelId: settings.piModel } : this.opts.currentModel?.() ?? this.opts.model;
      let model = this.opts.models.getModel(ref.provider, ref.modelId);
      if (!model) {
        log.warn("pi runtime model unavailable; using startup model", { provider: ref.provider, model: ref.modelId });
        ref = this.opts.model;
        model = this.opts.models.getModel(ref.provider, ref.modelId);
      }
      if (!model) throw new Error("pi 启动模型不可用");
      const agent = { model: ref, thinkingLevel: clampThinkingLevel(model, settings?.piThinkingLevel ?? this.opts.thinkingLevel) };
      if (id !== undefined) {
        const conv = await this.harness.conversation(id as ConversationId, context);
        if (!conv) throw new Error("pi 会话不存在");
        await conv.configure(agent, context);
        await this.observeContext(key, conv, ref);
        await this.persistMirrors();
        return conv;
      }
      const conv = await this.harness.createConversation({ ownership: { kind: "ownerless" }, agent,
        init: async (tx, conversationId) => { (await tx.doc(PiThreadsDoc))[key] = conversationId; },
      }, context);
      this.keys.set(Number(conv.id), key);
      this.opts.contextUsage?.reset("pi", key);
      await this.observeContext(key, conv, ref);
      await this.persistMirrors();
      if (this.attached) await this.watchThread(key, conv.id);
      return conv;
    });
  }

  /** 按本轮身份选择 IM 与定时工具的 schema（调用时仍逐次复核身份）。 */
  private async configureTools(conv: Conversation, threadKey: string): Promise<void> {
    const binding = this.opts.turns.binding(threadKey);
    const permissions = await this.opts.grants?.permissions(binding) ?? { actorIsOwner: false, target: false, auth: false };
    const im = createPiImExtensions({ ...this.opts, binding: id => this.binding(id) }), selected = permissions.auth ? im.owner : permissions.target ? im.targeted : im.basic;
    const schedule = createPiScheduleExtensions(id => this.binding(id), this.opts.scheduleTools);
    const available = await this.opts.scheduleTools?.permissions(binding);
    const scheduleExtension = available?.scheduleControl ? schedule.control : available?.schedule ? schedule.management : undefined;
    await conv.configure({ extensions: {
      add: [selected, ...(scheduleExtension ? [scheduleExtension] : [])],
      remove: [...Object.values(im).filter(e => e.name !== selected.name),
        ...Object.values(schedule).filter(e => e.name !== scheduleExtension?.name)],
    } }, context);
  }

  private state(key: string, conv: ConversationId): ThreadState {
    let state = this.threads.get(key);
    if (!state || state.conv !== conv) { state = { conv, ...(state?.stream ? { stream: state.stream } : {}) }; this.threads.set(key, state); }
    return state;
  }

  private async content(record: InboundRecord): Promise<string> {
    return (await this.opts.turns.render([record])).text;
  }

  // ───────────── ThreadAdapter ─────────────

  startTurn(threadKey: ThreadKey, inputs: readonly InputRef[], turn: TurnContext, settings?: TicketSettings): Promise<{ turnId: string }> {
    if (this.closing) return Promise.reject(new Error("pi 后端正在关闭"));
    return this.serial(threadKey, async () => {
      const conv = await this.conversation(threadKey, settings);
      await this.configureTools(conv, threadKey);
      const records = this.opts.turns.records(inputs);
      const live = await this.harness.snapshot(LiveDoc, conv.id, context);
      const state = this.state(threadKey, conv.id);
      // 会话已有 run（宿主还没看到的唤醒回合）：全部并入；否则首条 followUp 开新 run，其余并入。
      let first: SubmissionId | undefined = live?.run?.inputs[0];
      for (const [index, record] of records.entries()) {
        const submission = await conv.submit({ type: "input", requestId: record.key, content: await this.content(record),
          whenBusy: live?.run || index > 0 ? "steer" : "followUp" }, context);
        first ??= submission.id;
      }
      if (first === undefined) throw new Error("pi 回合没有输入");
      const turnId = piTurnId(conv.id, first);
      if (state.active?.turnId === turnId) state.active.owner = "host";
      else {
        const active: ActiveTurn = { turnId, first, owner: "host" };
        state.active = active;
        this.waitTurn(threadKey, active);
      }
      trace.event("turn:" + turnId, "dispatched", { detail: { backend: "pi", conversation_key: threadKey, conversation: conv.id,
        kind: turn.kind, inputs: inputs.map(i => i.inboundKey), joined: !!live?.run } });
      return { turnId };
    });
  }

  steer(threadKey: ThreadKey, turnId: string, input: InputRef): Promise<"ok" | "no_active_turn"> {
    if (this.closing) return Promise.resolve("no_active_turn");
    return this.serial(threadKey, async () => {
      const active = this.threads.get(threadKey)?.active;
      if (!active || active.turnId !== turnId) return "no_active_turn" as const;
      const record = await (await this.harness.submission(active.first, context))?.status(context);
      if (!record || record.status === "done" || record.status === "unanswered") return "no_active_turn" as const;
      const conv = await this.harness.conversation(this.threads.get(threadKey)!.conv, context);
      if (!conv) return "no_active_turn" as const;
      const [rec] = this.opts.turns.records([input]);
      await conv.submit({ type: "input", requestId: rec!.key, content: await this.content(rec!), whenBusy: "steer" }, context);
      trace.event("turn:" + turnId, "steered", { detail: { backend: "pi", input: input.inboundKey } });
      return "ok" as const;
    });
  }

  /** 面板"停止"与看门狗：连同子 agent 一起中止；回合结束仍由提交结束驱动。 */
  async interrupt(threadKey: ThreadKey): Promise<void> {
    const id = (await this.readThreadIds())[threadKey];
    if (id === undefined) return;
    const conv = await this.harness.conversation(id as ConversationId, context);
    await conv?.abort(context, { background: true });
  }

  async recoverTurn(threadKey: ThreadKey, turnId: string): Promise<"alive" | "lost"> {
    const parsed = parseTurnId(turnId);
    if (!parsed || (await this.readThreadIds())[threadKey] !== Number(parsed.conv)) return "lost";
    if (!await this.harness.submission(parsed.first, context)) return "lost";
    const active: ActiveTurn = { turnId, first: parsed.first, owner: "host" };
    this.state(threadKey, parsed.conv).active = active;
    this.waitTurn(threadKey, active);
    return "alive";
  }

  // ───────────── 回合跟踪 ─────────────

  /** 回合首条提交结束即回合结束；之后若会话已开始下一次 run（排队的子 agent 汇报），按唤醒回合回报。 */
  private waitTurn(threadKey: string, active: ActiveTurn): void {
    void (async () => {
      let status: TurnStatus = "completed", error: string | undefined, answer: EntryId | undefined;
      try {
        const submission = await this.harness.submission(active.first, context);
        if (!submission) { status = "lost"; error = "pi 提交不存在"; }
        else {
          const settled = await submission.wait(context);
          if (settled.status === "done" && settled.type === "input") answer = settled.answer;
          else { status = "failed"; error = settled.status === "unanswered" ? settled.reason : settled.status; }
        }
      } catch (err) {
        if (this.closing) return;
        status = "failed"; error = err instanceof Error ? err.message : String(err);
      }
      if (this.closing) return;
      await this.serial(threadKey, async () => {
        const state = this.threads.get(threadKey);
        if (state?.active?.turnId !== active.turnId) return;
        delete state.active;
        await this.recordUsage(threadKey, active.turnId, answer).catch(err => log.warn("pi context usage update failed", { thread: threadKey, error: err }));
        this.host?.onTurnCompleted(threadKey as ThreadKey, active.turnId, { status, ...(error ? { error } : {}) });
        const live = await this.harness.snapshot(LiveDoc, state.conv, context);
        if (live?.run && live.run.inputs[0] !== active.first) await this.startWake(threadKey, state, live.run.inputs[0]!);
      });
    })().catch(err => log.warn("pi turn watcher failed", { thread: threadKey, turn: active.turnId, error: err }));
  }

  private async recordUsage(threadKey: string, turnId: string, answer: EntryId | undefined): Promise<void> {
    if (!this.opts.contextUsage || answer === undefined) return;
    const key = "turn:" + turnId, observer = this.contextObservers.get(threadKey);
    await observer?.synchronize(key, answer);
    const last = observer?.lastRequest(key);
    const capacity = this.opts.contextUsage.get("pi", threadKey);
    if (!capacity) return;
    this.opts.contextUsage.recordTurn("pi", threadKey, {
      windowTokens: capacity.windowTokens, compaction: capacity.compaction,
      ...(last ? { usedTokens: last.usedTokens, cachedTokens: last.cachedTokens } : {}),
    }, key);
  }

  /** 宿主不知道的 run（子 agent 汇报唤醒等）：按后端开的回合回报（身份为唤醒）。 */
  private async startWake(threadKey: string, state: ThreadState, first: SubmissionId): Promise<void> {
    const active: ActiveTurn = { turnId: piTurnId(state.conv, first), first, owner: "backend" };
    state.active = active;
    const record = await (await this.harness.submission(first, context))?.status(context);
    const report = isSubagentReportRequest(record?.requestId);
    trace.event("turn:" + active.turnId, "received", { detail: { text: report ? "（子 agent 汇报唤醒）" : "（后端唤醒回合）", sender: "",
      thread_key: threadKey, kind: "wake" } });
    trace.event("turn:" + active.turnId, "dispatched", { detail: { backend: "pi", conversation_key: threadKey, conversation: state.conv, kind: "wake" } });
    this.host?.onTurnStarted(threadKey as ThreadKey, active.turnId, "backend");
    this.waitTurn(threadKey, active);
  }

  /** 接上会话事件流：run 开始时识别唤醒回合，模型与工具活动刷新看门狗。须在会话键串行内调用。 */
  private async watchThread(threadKey: string, conv: ConversationId): Promise<void> {
    const state = this.state(threadKey, conv);
    if (state.stream) return;
    const stream = await watchEvents(this.harness, conv, context);
    state.stream = stream;
    const handle = async (events: readonly AgentEvent[]) => {
      for (const event of events) {
        const run = event.type === "run_start" ? event.inputs : event.type === "snapshot" ? event.run?.inputs : undefined;
        if (run?.length) {
          const current = this.threads.get(threadKey);
          if (!current || current.conv !== conv) return;
          // 事件按提交顺序串行处理，可能晚于回合结束：以已提交的 run 为准，过期的 run 不再回报。
          const live = await this.harness.snapshot(LiveDoc, conv, context);
          if (live?.run?.inputs[0] !== run[0]) continue;
          // 宿主有回合进行中时出现的 run 并入该回合（同一会话一次只有一个回合）。
          if (current.active) this.host?.onActivity(threadKey as ThreadKey);
          else await this.startWake(threadKey, current, run[0]!);
        } else if (["message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end", "turn_start"].includes(event.type)) {
          this.host?.onActivity(threadKey as ThreadKey);
        }
      }
    };
    await handle([stream.snapshot]);
    stream.start(async events => { await this.serial(threadKey, () => handle(events)); });
  }

  /**
   * 面板"重置会话"：会话有回合进行中时拒绝（不打断）；映射置空、旧会话保留在 SQLite 中作归档，
   * 归档记录与映射同事务提交，再重写 JSON/JSONL 镜像；下一条消息新建会话。
   */
  resetThread(key: string, reason = "dashboard"): Promise<number | null> {
    if (key !== "owner" && !isScope(key)) return Promise.reject(new Error("非法会话键"));
    return this.serial(key, () => this.serial("mapping", async () => {
      if (this.threads.get(key)?.active) throw new Error("会话正在处理中，请在本轮结束后再重置");
      const id = (await this.readThreadIds())[key] ?? null;
      if (id === null) { await this.backfillResetContext(key); return null; }
      await this.harness.commit(async tx => {
        (await tx.doc(PiThreadsDoc))[key] = null;
        const archive = await tx.doc(PiThreadsArchiveDoc);
        archive.rows.push({ key, conversation: id, archived_at: new Date().toISOString(), reason });
        archive.rows = archive.rows.slice(-THREAD_ARCHIVE_LIMIT);
      }, context);
      this.keys.delete(id);
      const state = this.threads.get(key);
      this.threads.delete(key);
      await state?.stream?.stop().catch(() => undefined);
      await this.persistMirrors();
      await this.contextObservers.get(key)?.close();
      this.contextObservers.delete(key);
      await this.backfillResetContext(key);
      log.info("pi conversation reset", { conversation_key: key, conversation: id, reason });
      return id;
    }));
  }

  /** 手动压缩：pi 在会话工作时也能压缩（摘要在下一个边界放置），保留当前会话映射。 */
  async compactThread(key: string): Promise<"compacted" | "unchanged"> {
    if (key !== "owner" && !isScope(key)) throw new Error("非法会话键");
    const id = (await this.readThreadIds())[key];
    if (id === undefined) return "unchanged";
    const conv = await this.harness.conversation(id as ConversationId, context);
    if (!conv) throw new Error("pi 会话不存在");
    const task = await conv.compact(undefined, context);
    const { state: { outcome } } = await this.harness.waitForTask(task, context);
    if (outcome.status !== "completed") throw new Error(`pi 会话压缩失败（${outcome.status}）`);
    if (this.opts.contextUsage) await refreshPiCompactionUsage(conv, key, this.opts.contextUsage);
    return "compacted";
  }

  /** 关闭前调用：之后的回合结束不再回报（重启后由宿主恢复），pi 回合与子 agent 保留检查点。 */
  beginShutdown(): void { this.closing = true; }

  async close(): Promise<void> {
    this.beginShutdown();
    await Promise.all([...this.threads.values()].map(state => state.stream?.stop().catch(() => undefined)));
    await Promise.all([...this.contextObservers.values()].map(observer => observer.close()));
    this.contextObservers.clear();
    await this.harness.close(context);
    await Promise.allSettled([...this.tails.values()]);
  }
}

export { traceKey };

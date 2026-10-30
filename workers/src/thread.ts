import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { Type, type Static } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness, InboxDoc, LiveDoc, section, type Conversation, type Registry, type SettledSubmissionRecord, type Submission } from "@earendil-works/pi-durable";
import { DurableObjectSqliteDatabase, openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import type { SqliteValue } from "@earendil-works/chord/sqlite";
import type { Env } from "./env";
import { inboundKey, ownerIds, scopeOf, type InboundInput, type Target, type TurnKind } from "./policy";
import { effectiveSettings, type ModelSelection, type Settings, type SettingsSnapshot } from "./settings";
import { MESSAGE_SCHEMA, QQ_CONTEXT_DESCRIPTION, QQ_CONTEXT_PARAMETERS, recordMessage, recall, type RecallOptions } from "./context";
import { EVENT_TURN_IDENTITY, PI_SAFETY_RULE, SEND_RULE, WEB_RULE, subagentTurnIdentity, turnIdentity } from "./prompt";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { modelChange, openModels, sameSelection } from "./models";
import { remoteCredentials } from "./model-credentials";
import { MEMORY_SCHEMA } from "./memory/schema";
import { MemoryStore, MemoryStoreError, type Profile } from "./memory/store";
import type { MemoryRow } from "./memory/types";
import { parseImport } from "./memory/import";
import { createMemoryTools, searchMemory, type MemoryBinding } from "./memory/tools";
import { MEMORY_RULE, type memoryParameters } from "./memory/contracts";
import { renderMemorySection } from "./memory/render";
import { formatBeijingTime } from "./memory/time";
import { MemoryExtractor, directComplete, EXTRACT_ALARM_DELAY_MS, type ExtractComplete } from "./memory/extractor";
import { maintenanceConfig, maintenanceStatus, runMaintenanceJob, type MaintenanceJob, type MaintenanceReport } from "./maintenance";

import { MCP_CATALOG_SCHEMA } from "./mcp/catalog";
import { MCP_CONFIG } from "./mcp/config";
import { ThreadMcp } from "./mcp";
import { createScheduleExtension, type ScheduleAccess } from "./schedule/tools";
import { parseScheduleInputKey } from "./schedule/run";
import type { ScheduleConversation } from "./schedule/types";
import { createGmailTools } from "./gmail/tools";
import type { EventRunStatus } from "./events/model";
import { cleanOutgoing } from "./send-clean";
import { createWebPageTool } from "./tools/web-page";
import { SkillCatalog } from "./skills";
import { importHistory, importThreadKey, parseMessageImport, type MessageImportResult } from "./message-import";
import { ParentSubagents, SUBAGENT_SCHEMA, type SubagentCaller, type SubagentView } from "./subagent/parent";
import { subagentName, type ParentSubagentStatus, type SubagentEntry, type SubagentMeta, type SubagentReport } from "./subagent/model";
import { createCodingExtension } from "./tools/coding";

const context = BACKGROUND_CONTEXT;
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
type InboundRow = {
  message_id: string; platform_message_id: string; user_id: string; self_id: string; text: string; received_at: number;
  status: "queued" | "done" | "failed"; chat_kind: "private" | "group"; chat_id: string; nickname: string;
  scope_name: string; turn_id: string | null; when_busy: "steer" | "followUp" | null; kind: TurnKind;
};
// 模型可见工具按会话配置生效，只能在会话空闲时切换；两种档位的输入永远不会进入同一个 run。定时输入归 chat 档。
type ToolProfile = "chat" | "event";
const EVENT_MODEL_TOOLS = new Set(["send_message", "qq_context", "mem_search", "gmail_search", "gmail_read", "web_page", "read_skill",
  ...(MCP_CONFIG.enabled && MCP_CONFIG.servers.some(server => server.enabled && server.tools.eventAllow.length) ? ["codemode"] : [])]);
const profileOf = (row: InboundRow): ToolProfile => row.kind === "event" ? "event" : "chat";
type Runtime = { harness: Harness; root: Conversation; registry: Registry; selection: ModelSelection; profile: ToolProfile; mcp?: ThreadMcp };
const targetOf = (row: InboundRow): Target => row.chat_kind === "group" ? { kind: "group", groupId: row.chat_id } : { kind: "private", userId: row.chat_id };
export type EventQuery = { kind?: string; result?: string; before?: number; limit: number };
export type AuditEvent = { id: number; at: number; kind: string; detail: unknown };
// 结果过滤按事件类型取各自的 JSON 字段；表外的类型不参与结果过滤。
const EVENT_RESULT_PATH: Record<string, string> = { mcp_call: "$.result", mcp_catalog: "$.status", web_search: "$.result", generate_image: "$.result",
  coding_exec: "$.result", coding_read: "$.result", coding_write: "$.result", coding_edit: "$.result" };
const SETTINGS_TTL_MS = 60_000;

export class ThreadDO extends DurableObject<Env> {
  private readonly database = new DurableObjectSqliteDatabase(this.ctx.storage);
  private initialized?: Promise<void>;
  private modelsCache?: MutableModels;
  private runtime?: Promise<Runtime>;
  private admissions: Promise<void> = Promise.resolve();
  private settingsCache?: { at: number; load: Promise<SettingsSnapshot> };
  private readonly waiters = new Map<string, (submission: Submission | undefined) => void>();
  private idleWait?: Promise<void>;
  private readonly skills = new SkillCatalog(() => this.env.REGISTRY.getByName("main"));
  private readonly subagents = new ParentSubagents({ db: this.database, env: this.env, thread: () => this.namespace(),
    wake: input => this.queueInput(input), wakeBy: at => this.wakeBy(at), audit: (kind, detail) => this.audit(kind, detail) });

  private initialize(): Promise<void> {
    return this.initialized ??= this.database.transaction(async tx => {
      await tx.exec(`
        CREATE TABLE IF NOT EXISTS inbound (
          message_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, text TEXT NOT NULL,
          received_at INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('queued', 'done', 'failed'))
        );
        CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY, message_id TEXT NOT NULL, text TEXT NOT NULL, sent_at INTEGER NOT NULL);
        ${MESSAGE_SCHEMA}
        ${MEMORY_SCHEMA}
        ${MCP_CATALOG_SCHEMA}
        ${SUBAGENT_SCHEMA}
      `);
      // 已部署的 P0 表与 submission.requestId 必须保留，新增列用默认值兼容旧回合恢复。
      const columns = await tx.all<{ name: string }>("PRAGMA table_info(inbound)");
      for (const [name, definition] of Object.entries({
        chat_kind: "TEXT NOT NULL DEFAULT 'private'", chat_id: "TEXT NOT NULL DEFAULT ''",
        nickname: "TEXT NOT NULL DEFAULT ''", self_id: "TEXT NOT NULL DEFAULT ''",
        scope_name: "TEXT NOT NULL DEFAULT ''", platform_message_id: "TEXT NOT NULL DEFAULT ''", when_busy: "TEXT", turn_id: "TEXT",
        kind: "TEXT NOT NULL DEFAULT 'message'",
      })) if (!columns.some(column => column.name === name)) await tx.exec(`ALTER TABLE inbound ADD COLUMN ${name} ${definition}`);
      const outboxColumns = await tx.all<{ name: string }>("PRAGMA table_info(outbox)");
      if (!outboxColumns.some(column => column.name === "turn_id")) await tx.exec("ALTER TABLE outbox ADD COLUMN turn_id TEXT");
      // 跟进输入会并入同一 Pi run、共用 turn_id；定时运行的发送条数只能按输入计。
      if (!outboxColumns.some(column => column.name === "input_id")) await tx.exec("ALTER TABLE outbox ADD COLUMN input_id TEXT");
      await tx.exec("CREATE INDEX IF NOT EXISTS inbound_turn ON inbound(turn_id); CREATE INDEX IF NOT EXISTS outbox_turn ON outbox(turn_id)");
      await tx.run("UPDATE inbound SET chat_id = user_id WHERE chat_id = ''");
      await tx.run("UPDATE inbound SET platform_message_id = message_id WHERE platform_message_id = ''");
    });
  }

  async ingest(input: InboundInput): Promise<{ repliedToSelf: boolean }> {
    await this.initialize();
    // 汇报来自本线程自己派出的子 agent，命名空间在派出时已绑定；userId 可能为空（基础权限），不能按它重算命名空间。
    if (input.kind === "subagent") return { repliedToSelf: false };
    const ns = input.target.kind === "private" && ownerIds(this.env).includes(input.userId) ? "owner" : scopeOf(input.target);
    if (input.kind === "event" && ns !== "owner") throw new Error("event input must bind the owner thread");
    await this.bindNamespace(ns);
    // 定时与事件等非聊天输入不进消息库，qq_context 与记忆抽取只看到真实聊天。
    if ((input.kind ?? "message") === "message") await this.database.transaction(tx => recordMessage(tx, input));
    const replied = input.replyToId === null ? undefined
      : await this.database.get("SELECT 1 FROM messages WHERE scope = ? AND message_id = ? AND is_self = 1", scopeOf(input.target), input.replyToId);
    return { repliedToSelf: replied !== undefined };
  }

  private open(): Promise<Runtime> {
    return this.runtime ??= this.openRuntime().catch(error => {
      this.runtime = undefined;
      throw error;
    });
  }

  private async currentInput(harness: Harness, read: Pick<Harness, "snapshot">, conversationId: Conversation["id"], callContext: Context): Promise<InboundRow | undefined> {
    const live = await read.snapshot(LiveDoc, conversationId, callContext);
    // Pi 的 run.taskId 会随工具续轮变化；首条输入 id 在续轮和插话期间稳定，作为宿主回合键。
    if (live?.run) {
      const keys: string[] = [];
      for (const id of live.run.inputs) {
        const record = await (await harness.submission(id, callContext))?.status(callContext);
        if (record?.requestId) keys.push(record.requestId);
      }
      const turnId = `turn:${live.run.inputs[0]}`;
      await this.database.transaction(async tx => {
        for (const key of keys) await tx.run("UPDATE inbound SET turn_id = ? WHERE message_id = ?", turnId, key);
      });
    }
    const inputId = live?.run?.inputs.at(-1);
    const handle = inputId ? await harness.submission(inputId, callContext) : undefined;
    const submission = await handle?.status(callContext);
    return submission?.requestId ? this.database.get<InboundRow>("SELECT * FROM inbound WHERE message_id = ?", submission.requestId) : undefined;
  }

  // 回合与记忆抽取共用一个 Models；OAuth 凭据经 Registry 读写，刷新也在 Registry 的锁里串行。
  private models(): MutableModels {
    return this.modelsCache ??= openModels(this.env, remoteCredentials(() => this.env.REGISTRY.getByName("main")));
  }

  private async openRuntime(): Promise<Runtime> {
    await this.initialize();
    const models = this.models(), selection = (await this.loadSettings(true)).model;
    const memory = new MemoryStore(this.database, await this.namespace());
    // 相同 storage 对象共享事务队列，避免宿主写入被 Pi 的事务一起回滚。
    const storage = await openDurableObjectSqliteStorage(this.ctx.storage, { prefix: "pi_" });
    const registry = createRegistry();
    registry.install(defineExtension({
      name: "cs-workers",
      sections: [
        section("qq", () => SEND_RULE + "\n" + WEB_RULE + "\n" + PI_SAFETY_RULE + "\n" + MEMORY_RULE, { tag: false }),
        section("memory", () => renderMemorySection(memory), { tag: false }),
        section("turn-identity", async (api, callContext) => {
          const input = await this.currentInput(harness, api.read, api.conversationId, callContext);
          if (input?.kind === "event") return EVENT_TURN_IDENTITY;
          if (input?.kind === "subagent") return subagentTurnIdentity({ userId: input.user_id, nickname: input.nickname, target: targetOf(input), scopeName: input.scope_name },
            ownerIds(this.env).includes(input.user_id));
          return input ? turnIdentity({ userId: input.user_id, nickname: input.nickname, target: targetOf(input), scopeName: input.scope_name }, ownerIds(this.env).includes(input.user_id)) : undefined;
        }, { tag: false }),
        // 模型没有时钟；按本轮输入的到达时刻给时间，同一回合内文本不变，不打散提示缓存。
        section("time", async (api, callContext) => {
          const input = await this.currentInput(harness, api.read, api.conversationId, callContext);
          if (!input) return undefined;
          const ms = input.received_at < 1e12 ? input.received_at * 1000 : input.received_at;
          return `现在是北京时间 ${formatBeijingTime(ms)}（${WEEKDAYS[new Date(ms + 8 * 3600_000).getUTCDay()]}）；今天、明天、下周这类相对时间都按北京时间理解。`;
        }, { tag: false }),
        section("skills", () => this.skills.section(), { tag: false }),
      ],
      tools: [...createMemoryTools(memory, async (api, callContext) => {
        const input = await this.currentInput(harness, api, api.conversationId, callContext);
        return input ? this.memoryBinding(input, memory.ns) : undefined;
      }), ...(memory.ns === "owner" ? createGmailTools(async (api, callContext) => {
        const input = await this.currentInput(harness, api, api.conversationId, callContext);
        return input ? this.ownerTurnKind(input) : undefined;
      }, () => this.env.EVENTS.getByName("main")) : []),
      createWebPageTool(),
      this.skills.tool(),
      defineTool({
        name: "send_message", description: "向本回合所在 QQ 会话发送纯文本；群回复自动 @ 本轮发送者。",
        parameters: Type.Object({ text: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
        // 发 QQ 是外部副作用，中断后禁止自动重放，避免重复发送。
        replay: "unsafe",
        execute: async ({ text }, api, toolContext) => {
          const input = await this.currentInput(harness, api, api.conversationId, toolContext);
          if (!input) throw new Error("current input missing");
          return { output: [{ type: "text", text: JSON.stringify(await this.deliver(input, cleanOutgoing(text))) }] };
        },
      }), defineTool({
        name: "qq_context", description: QQ_CONTEXT_DESCRIPTION, parameters: QQ_CONTEXT_PARAMETERS,
        replay: "safe",
        execute: async (options, api, toolContext) => {
          const input = await this.currentInput(harness, api, api.conversationId, toolContext);
          if (!input) throw new Error("current input missing");
          // scope 只来自当前输入，模型没有选择其他会话的参数，owner 也不能跨账号召回。
          return { output: [{ type: "text", text: await recall(this.database, scopeOf(targetOf(input)), options) }] };
        },
      }), this.subagents.tool(async (api, callContext) => this.subagentCaller(await this.currentInput(harness, api, api.conversationId, callContext)),
        async () => (await this.loadSettings(true)).model)].map(tool => ({ ...tool, callers: ["model"] as const })),
    }));
    // 沙箱 coding 工具只在 owner 线程注册，只有 owner 亲自发消息的回合能调用。
    if (memory.ns === "owner") registry.install(createCodingExtension({
      allowed: async (api, callContext) => {
        const input = await this.currentInput(harness, api, api.conversationId, callContext);
        return !!input && this.ownerTurnKind(input) === "message" && input.user_id !== input.self_id;
      },
      sandbox: () => this.env.SANDBOX.getByName(memory.ns),
      record: (kind, detail) => this.audit(kind, detail),
    }));
    if (memory.ns === "owner" || memory.ns.startsWith("group:")) {
      registry.install(createScheduleExtension(this.env, memory.ns as ScheduleConversation, async (api, callContext) =>
        this.scheduleAccess(await this.currentInput(harness, api, api.conversationId, callContext))));
    }
    const mcp = memory.ns === "owner" ? new ThreadMcp(this.database, this.env, registry, async (api, callContext) => {
      const input = await this.currentInput(harness, api, api.conversationId, callContext);
      return input ? this.ownerTurnKind(input) : undefined;
    }) : undefined;
    await mcp?.restore();
    // Codex 默认先走 WebSocket 并按会话缓存连接；DO 里的连接跨不了请求，固定用 SSE。其他 provider 忽略这一项。
    const harness = await Harness.open(storage, { models, registry, settings: { stream: { transport: "sse" } } }, context);
    const root = await harness.root(context, { agent: modelChange(selection) });
    await root.configure(modelChange(selection), context);
    const runtime: Runtime = { harness, root, registry, selection, profile: "chat", mcp };
    await this.applyProfile(runtime, await this.ctx.storage.get<ToolProfile>("tool_profile") ?? "chat");
    // 已被 Pi 接收过的输入按 requestId 幂等重交；尚未接收的由 pump 按工具档位继续接纳。
    for (const row of await this.database.all<InboundRow>("SELECT * FROM inbound WHERE status = 'queued' AND when_busy IS NOT NULL ORDER BY rowid")) {
      this.track(row.message_id, await this.admit(runtime, row));
    }
    this.ctx.waitUntil(this.pump());
    // 快照先装配，远端离线不阻塞 Harness 恢复；首次执行仍强制核对完整目录。
    if (mcp) this.ctx.waitUntil(mcp.refreshAll().then(() => {}));
    harness.resume();
    void harness.closed.then(async () => { this.runtime = undefined; await mcp?.close(); });
    return runtime;
  }

  /** 发到本回合所在会话并记进 outbox 与消息库。 */
  private async deliver(input: InboundRow, text: string): Promise<{ status: string; message_id?: string; reason?: string }> {
    const target = targetOf(input), at = target.kind === "group" && input.kind === "message" ? input.user_id : undefined;
    const bridge = this.env.BRIDGE.getByName("napcat");
    try {
      const receipt = await bridge.send(target, text, at);
      await this.database.transaction(async tx => {
        await tx.run("INSERT INTO outbox (message_id, text, sent_at, turn_id, input_id) VALUES (?, ?, ?, ?, ?)", receipt.message_id, text, Date.now(), input.turn_id, input.message_id);
        await recordMessage(tx, { messageId: receipt.message_id, selfId: input.self_id, userId: input.self_id,
          nickname: "机器人", target, text, routeText: text, time: Math.floor(Date.now() / 1000),
          mentionedSelf: false, replyToId: input.platform_message_id, imageCount: 0, scopeName: input.scope_name }, true);
      });
      return { status: "sent", message_id: receipt.message_id };
    } catch (error) {
      // RPC 可能归一化 Error.name，因此用固定前缀识别可向模型说明的拒绝。
      if (!(error instanceof Error)) throw error;
      if (error.message === "channel_down") return { status: "failed", reason: "channel_down" };
      if (error.message.startsWith("send_rule: ")) return { status: "rejected", reason: error.message.slice(11) };
      throw error;
    }
  }

  private audit(kind: string, detail: object): Promise<unknown> {
    return this.database.run("INSERT INTO events(at, kind, detail) VALUES (?, ?, ?)", Date.now(), kind, JSON.stringify(detail));
  }

  private async admit({ harness, root }: Runtime, row: InboundRow): Promise<Submission> {
    let whenBusy = row.when_busy;
    if (!whenBusy) {
      // 先查排队，再读当前回合；已有他人排队时，后来的同人消息也不能越过队首。
      // 定时与事件输入不插话；它们的回合里来的消息也排到其后，不能并入这些运行。
      const inbox = await harness.snapshot(InboxDoc, root.id, context);
      const active = await this.currentInput(harness, harness, root.id, context);
      whenBusy = row.kind === "message" && active?.kind === "message" && active.user_id === row.user_id && !inbox?.items.some(item => item.mode === "followUp") ? "steer" : "followUp";
      await this.database.run("UPDATE inbound SET when_busy = ? WHERE message_id = ?", whenBusy, row.message_id);
    }
    return root.submit({ type: "input", content: row.text, requestId: row.message_id, whenBusy }, context);
  }

  private async applyProfile(runtime: Runtime, profile: ToolProfile): Promise<void> {
    const tools = new Map(runtime.registry.snapshot().tools().map(({ tool }) => [tool.name, tool]));
    await runtime.root.configure({ modelTools: profile === "event" ? [...tools.values()].filter(tool => EVENT_MODEL_TOOLS.has(tool.name)) : null }, context);
    await this.ctx.storage.put("tool_profile", profile);
    runtime.profile = profile;
  }

  // 面板改了模型后，从下一批接纳的输入起生效；取不到设置时沿用当前模型。
  private async syncModel(runtime: Runtime): Promise<void> {
    const selection = await this.loadSettings(true).then(settings => settings.model, () => runtime.selection);
    if (sameSelection(selection, runtime.selection)) return;
    await runtime.root.configure(modelChange(selection), context);
    runtime.selection = selection;
  }

  private async idle({ harness, root }: Runtime): Promise<boolean> {
    const [live, inbox] = await Promise.all([harness.snapshot(LiveDoc, root.id, context), harness.snapshot(InboxDoc, root.id, context)]);
    return !live?.run && !inbox?.items.length;
  }

  private track(key: string, submission: Submission | undefined): void {
    const waiter = this.waiters.get(key);
    this.waiters.delete(key);
    if (waiter) waiter(submission);
    else if (submission) this.ctx.waitUntil(this.settle(key, submission).then(() => {}, () => {}));
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.admissions.then(work);
    this.admissions = run.then(() => {}, () => {});
    return run;
  }

  // 同档位的输入立即接纳（含插话）；换档的输入等会话空闲后再切换工具配置，因此先到的另一档输入可能晚于后到的同档输入。
  private pump(afterIdle = false): Promise<void> {
    return this.serial(async () => {
      let runtime: Runtime;
      try { runtime = await this.open(); }
      catch {
        for (const key of [...this.waiters.keys()]) {
          await this.database.run("UPDATE inbound SET status = 'failed' WHERE message_id = ? AND status = 'queued'", key);
          this.track(key, undefined);
        }
        return;
      }
      for (;;) {
        const rows = await this.database.all<InboundRow>("SELECT * FROM inbound WHERE status = 'queued' AND when_busy IS NULL ORDER BY rowid");
        const admissible = rows.filter(row => profileOf(row) === runtime.profile);
        if (admissible.length) await this.syncModel(runtime);
        for (const row of admissible) {
          let submission: Submission | undefined;
          try { submission = await this.admit(runtime, row); }
          catch { await this.database.run("UPDATE inbound SET status = 'failed' WHERE message_id = ?", row.message_id); }
          this.track(row.message_id, submission);
        }
        const next = rows.find(row => profileOf(row) !== runtime.profile);
        if (!next) return;
        if (!await this.idle(runtime)) {
          // 失败 run 保留的排队项要等下一条输入才放行；空闲等待只重试一次，避免空转。
          if (!afterIdle && !this.idleWait) {
            this.idleWait = runtime.harness.waitForIdle(context).then(() => { this.idleWait = undefined; return this.pump(true); });
            this.ctx.waitUntil(this.idleWait);
          }
          return;
        }
        await this.applyProfile(runtime, profileOf(next));
      }
    }).catch(() => {});
  }

  private async eventStatus(row: InboundRow): Promise<EventRunStatus> {
    if (row.status !== "done") return row.status === "failed" ? "failed" : "queued";
    return await this.database.get("SELECT 1 FROM outbox WHERE input_id = ? LIMIT 1", row.message_id) ? "sent" : "silent";
  }

  private async settle(messageId: string, submission: Submission): Promise<{ status: "done" | "failed" }> {
    let status: "done" | "failed" = "failed";
    let fallbackTurn: string | undefined;
    let answer: SettledSubmissionRecord["answer"];
    try {
      const result = await submission.wait(context);
      status = result.status === "done" ? "done" : "failed";
      answer = result.answer;
      fallbackTurn = result.answer === undefined ? undefined : `answer:${result.answer}`;
    } finally {
      const extractor = await this.extractor(new MemoryStore(this.database, await this.namespace()));
      const row = await this.database.transaction(async tx => {
        const row = await tx.get<InboundRow>("UPDATE inbound SET status = ?, turn_id = COALESCE(turn_id, ?) WHERE message_id = ? RETURNING *", status, fallbackTurn ?? null, messageId);
        if (status !== "done" || !row?.turn_id) return row;
        const unfinished = await tx.get("SELECT 1 FROM inbound WHERE turn_id = ? AND status != 'done' LIMIT 1", row.turn_id);
        if (unfinished) return row;
        // 定时与事件回合的输出可能转述外部资料，没有聊天输入的回合不抽取，避免这些资料经抽取变成记忆。
        if (!await tx.get("SELECT 1 FROM inbound WHERE turn_id = ? AND kind = 'message' LIMIT 1", row.turn_id)) return row;
        await extractor.enqueue(row.turn_id, tx);
        if (await tx.get("SELECT 1 FROM extract_queue LIMIT 1")) await this.wakeBy(Date.now() + EXTRACT_ALARM_DELAY_MS);
        return row;
      });
      if (row?.kind === "schedule") await this.reportScheduleRun(row, status, answer);
      if (row?.kind === "event") {
        const outcome = await this.eventStatus(row);
        this.ctx.waitUntil(this.env.EVENTS.getByName("main").finishRun(messageId, outcome).catch(() => {
          console.error({ event: "event_finish_report_failed", status: outcome });
        }));
      }
      this.ctx.waitUntil(this.pump());
    }
    return { status };
  }

  private enqueue(input: InboundInput, wait: boolean): Promise<{ key: string; admitted?: Promise<Submission | undefined> } | undefined> {
    return this.serial(async () => {
      await this.ingest(input);
      const kind: TurnKind = input.kind ?? "message";
      // 事件与子 agent 汇报的入站键由投递方生成（来源与外部 id、子 agent 与请求），旧版无 self_id 的兼容判断不适用。
      const key = kind === "event" || kind === "subagent" ? input.messageId : inboundKey(input);
      if (kind !== "event" && kind !== "subagent" && await this.database.get<InboundRow>("SELECT * FROM inbound WHERE message_id = ? AND self_id = '' AND user_id = ?", input.messageId, input.userId)) return;
      const inserted = await this.database.get<InboundRow>(`INSERT OR IGNORE INTO inbound
        (message_id, platform_message_id, user_id, self_id, text, received_at, status, chat_kind, chat_id, nickname, scope_name, kind)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?) RETURNING *`, key, input.messageId, input.userId, input.selfId, input.text, input.time,
        input.target.kind, input.target.kind === "group" ? input.target.groupId : input.target.userId, input.nickname, input.scopeName ?? "", kind);
      if (!inserted) return;
      // 等待者必须在本串行段内登记，之后的 pump 才能把接纳结果交回调用方。
      return { key, ...(wait ? { admitted: new Promise<Submission | undefined>(resolve => this.waiters.set(key, resolve)) } : {}) };
    });
  }

  async submit(input: InboundInput): Promise<{ deduped: true } | { status: "done" | "failed" | "queued" }> {
    // 只串行接纳，不串行等待回合，否则同一发送者的插话也会被堵到回合结束。
    const queued = await this.enqueue(input, true);
    if (!queued?.admitted) return { deduped: true };
    void this.pump();
    const submission = await queued.admitted;
    if (!submission) return { status: "failed" };
    // ScheduleDO 只等接纳不等回合：结果由 settle 回写，alarm 不被长回合占住。
    if (input.kind === "schedule") {
      this.ctx.waitUntil(this.settle(queued.key, submission));
      return { status: "queued" };
    }
    return this.settle(queued.key, submission);
  }

  /** 事件服务的投递入口：入站行落库即返回，回合结果由 settle 回报事件服务。 */
  async deliverEvent(input: InboundInput): Promise<"accepted" | "duplicate"> {
    if (input.kind !== "event") throw new Error("deliverEvent requires an event input");
    return this.queueInput(input);
  }

  /** 入站行落库即返回，回合由 pump 接纳；同一入站键只入队一次。 */
  private async queueInput(input: InboundInput): Promise<"accepted" | "duplicate"> {
    const queued = await this.enqueue(input, false);
    if (!queued) return "duplicate";
    this.ctx.waitUntil(this.pump());
    return "accepted";
  }

  /** 子 agent 的汇报：作为 kind=subagent 的输入入队，归 chat 档、排在当前回合之后、不进消息库、不参与记忆抽取。 */
  async subagentReport(report: SubagentReport): Promise<"accepted" | "duplicate" | "ignored"> {
    await this.initialize();
    return this.subagents.report(report);
  }

  /** 子 agent 的 qq_context：只读派出它的会话。 */
  async subagentContext(id: string, options: RecallOptions): Promise<string> {
    await this.initialize();
    const access = await this.subagents.access(id);
    if (!access) throw new Error("subagent_unknown");
    return recall(this.database, access.scope, options);
  }

  /** 子 agent 的 mem_search：与 memoryBinding 同一条线，owner 命名空间只对确证的 owner 派出者开放，其他会话读本会话。 */
  async subagentMemory(id: string, args: Static<typeof memoryParameters.mem_search>): Promise<{ text: string; error?: true }> {
    await this.initialize();
    const access = await this.subagents.access(id), ns = await this.namespace();
    if (!access || !ns || ns === "owner" && !access.identity.as?.owner) return { text: "本轮身份未确证，不能访问记忆；本轮请勿重试。", error: true };
    try { return { text: await searchMemory(new MemoryStore(this.database, ns), args) }; }
    catch (error) { return { text: error instanceof Error ? error.message : "记忆操作失败", error: true }; }
  }

  async subagentList(): Promise<SubagentView[]> {
    await this.initialize();
    return this.subagents.list();
  }

  async cancelSubagent(id: string): Promise<ParentSubagentStatus | undefined> {
    await this.initialize();
    return this.subagents.cancel(id);
  }

  async subagentTranscript(id: string, limit: number): Promise<{ meta: SubagentMeta; entries: SubagentEntry[] } | undefined> {
    await this.initialize();
    if (!await this.subagents.exists(id)) return;
    return this.env.SUBAGENT.getByName(subagentName(await this.namespace(), id)).transcriptSummary(limit);
  }

  private subagentCaller(input: InboundRow | undefined): SubagentCaller | undefined {
    if (input?.kind !== "message" || !input.turn_id || input.user_id === input.self_id) return;
    return { identity: { turn: "message", as: { userId: input.user_id, nickname: input.nickname, owner: ownerIds(this.env).includes(input.user_id) } },
      origin: { target: targetOf(input), selfId: input.self_id, scopeName: input.scope_name } };
  }

  /** 让 alarm 不晚于 at：记忆抽取与子 agent 限时共用这一个 alarm。 */
  private async wakeBy(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  /** 事件服务对账：未知返回 undefined；仍在排队时顺带唤醒接纳，覆盖冷启动后无人触发的情况。 */
  async eventOutcome(key: string): Promise<EventRunStatus | undefined> {
    await this.initialize();
    const row = await this.database.get<InboundRow>("SELECT * FROM inbound WHERE message_id = ? AND kind = 'event'", key);
    if (!row) return;
    if (row.status === "queued") this.ctx.waitUntil(this.pump());
    return this.eventStatus(row);
  }

  private ownerTurnKind(input: InboundRow): TurnKind | undefined {
    if (!input.turn_id || input.chat_kind !== "private" || !ownerIds(this.env).includes(input.user_id)) return;
    return input.kind;
  }

  private scheduleAccess(input: InboundRow | undefined): ScheduleAccess {
    if (input?.kind === "schedule") {
      const key = parseScheduleInputKey(input.message_id);
      return key ? { kind: "control", scheduleId: key.scheduleId, fireKey: key.fireKey } : { kind: "none" };
    }
    // 子 agent 汇报回合继承派出者：派出者是确证的 owner 时与其消息回合同权。
    return (input?.kind === "message" || input?.kind === "subagent") && input.user_id !== input.self_id && ownerIds(this.env).includes(input.user_id)
      ? { kind: "manage", actor: `qq:${input.user_id}` } : { kind: "none" };
  }

  private async reportScheduleRun(row: InboundRow, status: "done" | "failed", answer: SettledSubmissionRecord["answer"]): Promise<void> {
    const key = parseScheduleInputKey(row.message_id);
    if (!key) return;
    const sent = (await this.database.get<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE input_id = ?", row.message_id))?.n ?? 0;
    let note = "";
    if (answer !== undefined) {
      try {
        const { harness } = await this.open();
        const message = (await harness.commit(tx => tx.entry(answer), context))?.model?.find(item => item.role === "assistant");
        if (message?.role === "assistant") note = message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("").slice(0, 200);
      } catch { /* 摘要只是记录，读不到不影响结果 */ }
    }
    try {
      await this.env.SCHEDULE.getByName("main").recordRun(key.scheduleId, { fire_key: key.fireKey, fire_at: key.fireAt, input_key: row.message_id,
        status: status === "failed" ? "failed" : sent ? "sent" : "silent", ...(status === "failed" ? { reason: "backend_failed" as const } : {}),
        sent, note, ended_at: Date.now() });
    } catch {
      // ScheduleDO 下次触发前会经 scheduleRunOutcome 补查，这里只记日志。
      console.error({ event: "schedule_record_failed", key: row.message_id });
    }
  }

  /** ScheduleDO 补查定时输入的结果；仍在排队时顺带唤醒接纳，让驱逐前的输入恢复执行。 */
  async scheduleRunOutcome(key: string): Promise<{ status: "queued" | "done" | "failed" | "missing"; sent: number }> {
    await this.initialize();
    const row = await this.database.get<InboundRow>("SELECT * FROM inbound WHERE message_id = ? AND kind = 'schedule'", key);
    if (row?.status === "queued") this.ctx.waitUntil(this.pump());
    const sent = (await this.database.get<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE input_id = ?", key))?.n ?? 0;
    return { status: row?.status ?? "missing", sent };
  }

  async stats() {
    await this.initialize();
    const rows = await this.database.all<{ status: "queued" | "done" | "failed"; n: number }>("SELECT status, COUNT(*) AS n FROM inbound GROUP BY status");
    const inbound = { queued: 0, done: 0, failed: 0 };
    for (const row of rows) inbound[row.status] = row.n;
    const out = await this.database.get<{ n: number; last: number | null }>("SELECT COUNT(*) AS n, MAX(sent_at) AS last FROM outbox");
    const active = await this.database.get<{ n: number }>("SELECT COUNT(*) AS n FROM memories WHERE status = 'active'");
    const profile = await this.database.get<{ n: number }>("SELECT COALESCE(SUM(length(CAST(text AS BLOB))), 0) AS n FROM profile");
    const queue = await this.database.get<{ n: number }>("SELECT COUNT(*) AS n FROM extract_queue");
    return { inbound, outbox: out?.n ?? 0, ...(out?.last ? { lastSentAt: out.last } : {}), subagents: { running: await this.subagents.running() },
      memory: { active: active?.n ?? 0, profileBytes: profile?.n ?? 0, extractQueue: queue?.n ?? 0 },
      maintenance: await maintenanceStatus(this.database, this.ctx.storage) };
  }

  private async bindNamespace(ns: string): Promise<void> {
    // RPC 的 ns 不能把不同会话的数据塞进同一个 DO；名称经绑定的 idFromName 复核。
    if (!this.ctx.id.equals(this.env.THREAD.idFromName(ns))) throw new Error("thread namespace mismatch");
    await this.database.run("INSERT OR IGNORE INTO thread_namespace(ns) VALUES (?)", ns);
  }

  private async namespace(): Promise<string> {
    const row = await this.database.get<{ ns: string }>("SELECT ns FROM thread_namespace LIMIT 1");
    if (row) return row.ns;
    if (this.ctx.id.equals(this.env.THREAD.idFromName("owner"))) return "owner";
    // P0/P1a 冷启动可从已有输入恢复；不能从客户端的显示名猜测命名空间。
    const input = await this.database.get<InboundRow>("SELECT * FROM inbound ORDER BY rowid LIMIT 1");
    if (!input) return "";
    const ns = scopeOf(targetOf(input));
    await this.bindNamespace(ns);
    return ns;
  }

  private memoryBinding(input: InboundRow, ns: string): MemoryBinding | undefined {
    if (!input.turn_id) return;
    const owner = ownerIds(this.env).includes(input.user_id);
    const expected = owner && input.chat_kind === "private" ? "owner" : scopeOf(targetOf(input));
    if (expected !== ns || input.user_id === input.self_id) return;
    // 事件回合绑定 owner 只为读取范围；写记忆须经主人的一句话，因此不给写权限。
    return { ns, owner: owner && input.kind !== "event", userId: input.user_id, turnId: input.turn_id, scope: scopeOf(targetOf(input)), messageId: input.platform_message_id };
  }

  // 抽取、摘要与整理都是无工具的单次补全，用当前选择的 provider；MEMORY_EXTRACT_MODEL 只换模型 id。
  private readonly complete: ExtractComplete = async (prompt, signal) => {
    const selection = (await this.loadSettings()).model;
    signal.throwIfAborted();
    return directComplete(this.models(), selection.provider, this.env.MEMORY_EXTRACT_MODEL?.trim() || selection.id)(prompt, signal);
  };

  /** 抽取判定读 60 秒缓存；接纳输入时传 fresh，面板改的模型下一回合就生效。 */
  private async loadSettings(fresh = false): Promise<Settings> {
    let cache = this.settingsCache;
    if (fresh || !cache || Date.now() - cache.at >= SETTINGS_TTL_MS) {
      const load = this.env.REGISTRY.getByName("main").settings();
      cache = this.settingsCache = { at: Date.now(), load };
      load.catch(() => { if (this.settingsCache?.load === load) this.settingsCache = undefined; });
    }
    return effectiveSettings(this.env, (await cache.load).overrides);
  }

  private async extractEnabled(ns: string): Promise<boolean> {
    if (!ns) return false;
    // 取不到设置时不抽取：面板可能刚关掉这个命名空间，宁可漏一轮也不按过期配置调用模型。
    try { return (await this.loadSettings()).extractNamespaces.includes(ns); }
    catch { return false; }
  }

  private async extractor(store: MemoryStore): Promise<MemoryExtractor> {
    const enabled = await this.extractEnabled(store.ns);
    return new MemoryExtractor(store, this.complete, () => enabled);
  }

  override async alarm(): Promise<void> {
    await this.initialize();
    const store = new MemoryStore(this.database, await this.namespace());
    // 先续约闹钟：处理中若进程中断，未领取的回合仍会被唤醒。
    await this.database.transaction(async () => { await this.ctx.storage.setAlarm(Date.now() + 65_000); });
    try {
      await this.subagents.expire(Date.now()).catch(error => {
        console.error({ event: "subagent_expire_failed", error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
      });
      await (await this.extractor(store)).drain();
    } finally {
      await this.database.transaction(async tx => {
        const deadline = await this.subagents.nextDeadline(tx), now = Date.now();
        // 已过期仍未处理完的限时（取消或入队失败）隔 30 秒重试，避免 alarm 立刻重入空转。
        const due = [await tx.get("SELECT 1 FROM extract_queue LIMIT 1") ? now + EXTRACT_ALARM_DELAY_MS : undefined,
          deadline === undefined ? undefined : deadline <= now ? now + 30_000 : deadline].filter(at => at !== undefined);
        if (due.length) await this.ctx.storage.setAlarm(Math.min(...due));
        else await this.ctx.storage.deleteAlarm();
      });
    }
  }

  async maintain(job: MaintenanceJob): Promise<MaintenanceReport> {
    await this.initialize();
    return runMaintenanceJob(job.kind, { db: this.database, kv: this.ctx.storage, store: new MemoryStore(this.database, await this.namespace()),
      complete: this.complete, config: maintenanceConfig(this.env), now: job.now });
  }

  async importMemory(value: unknown): Promise<{ inserted: number; skipped: number }> {
    const data = parseImport(value);
    await this.initialize();
    await this.bindNamespace(data.ns);
    return new MemoryStore(this.database, data.ns).import(data);
  }

  /** 历史聊天记录导入：路由按 importThreadKey 选线程，这里再经 idFromName 复核，不能把别的会话塞进本 DO。 */
  async importMessages(value: unknown): Promise<MessageImportResult> {
    const data = parseMessageImport(value);
    await this.initialize();
    await this.bindNamespace(importThreadKey(data.scope, ownerIds(this.env)));
    const result = await this.database.transaction(tx => importHistory(tx, data));
    await this.audit("history_import", result);
    return result;
  }

  async events(q: EventQuery): Promise<{ events: AuditEvent[]; next?: number }> {
    await this.initialize();
    const where: string[] = [], args: SqliteValue[] = [];
    if (q.kind) { where.push("kind = ?"); args.push(q.kind); }
    if (q.result) {
      where.push(`CASE kind ${Object.keys(EVENT_RESULT_PATH).map(() => "WHEN ? THEN json_extract(detail, ?) = ?").join(" ")} ELSE 1 END`);
      for (const [kind, path] of Object.entries(EVENT_RESULT_PATH)) args.push(kind, path, q.result);
    }
    if (q.before !== undefined) { where.push("rowid < ?"); args.push(q.before); }
    const limit = Math.min(200, Math.max(1, Math.trunc(q.limit)));
    const rows = await this.database.all<{ id: number; at: number; kind: string; detail: string }>(
      `SELECT rowid AS id, at, kind, detail FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY rowid DESC LIMIT ?`, ...args, limit + 1);
    const events = rows.slice(0, limit).map((row): AuditEvent => ({ id: row.id, at: row.at, kind: row.kind, detail: JSON.parse(row.detail) }));
    return rows.length > limit ? { events, next: events[events.length - 1].id } : { events };
  }

  async stop(): Promise<{ stopped: boolean }> {
    await this.initialize();
    if (!await this.database.get("SELECT 1 FROM inbound WHERE status = 'queued' LIMIT 1")) return { stopped: false };
    const idle = (await this.open()).root.abort(context);
    this.ctx.waitUntil(idle);
    // 中止在第一次提交时就已生效；等待 QQ 回执的发送工具要到自身超时才结束，不让管理请求一直挂着。
    await Promise.race([idle, scheduler.wait(2000)]);
    return { stopped: true };
  }

  async refreshMcp(): Promise<{ server: string; status: string; tools: number }[]> {
    const { mcp } = await this.open();
    if (!mcp) throw new Error("mcp_unavailable");
    return mcp.refreshAll();
  }

  private async adminStore(ns: string): Promise<MemoryStore> {
    await this.initialize();
    await this.bindNamespace(ns);
    return new MemoryStore(this.database, ns);
  }

  async memoryView(ns: string, query: string): Promise<{ profile: Profile; memories: MemoryRow[] }> {
    const store = await this.adminStore(ns), q = query.trim(), id = /^#(\d{1,15})$/.exec(q);
    const memories = id ? [await store.get(Number(id[1]))].filter(row => row !== undefined)
      : q ? await store.search({ query: q, limit: 20 }) : await store.recent(50);
    return { profile: await store.profile(), memories };
  }

  async forgetMemory(ns: string, id: number): Promise<{ status: "forgotten" | "not_found" }> {
    const store = await this.adminStore(ns);
    if (!await store.get(id)) return { status: "not_found" };
    await store.forget(id, "admin", "面板删除");
    return { status: "forgotten" };
  }

  async writeProfile(ns: string, text: string, expected: string): Promise<{ status: "ok" | "conflict"; current: Profile } | { status: "invalid"; reason: string }> {
    const store = await this.adminStore(ns);
    try {
      const result = await store.writeProfile(text, expected);
      return { status: result.ok ? "ok" : "conflict", current: result.current };
    } catch (error) {
      if (error instanceof MemoryStoreError) return { status: "invalid", reason: error.message };
      throw error;
    }
  }

  async mcpToolCounts(): Promise<Record<string, number>> {
    await this.initialize();
    const rows = await this.database.all<{ server_id: string; n: number }>("SELECT server_id, COUNT(*) AS n FROM mcp_catalog GROUP BY server_id");
    return Object.fromEntries(rows.map(row => [row.server_id, row.n]));
  }
}

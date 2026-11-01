import { createAccessExtension } from "./tools/access";
import { createWorkspaceAdminApi, type WorkspaceAdminApi, type WorkspaceMergeInput } from "./sandbox/admin";
import { createWorkspaceAdminExtension } from "./tools/workspace-admin";
import type { McpAdminRpc } from "./admin/mcp-routes";
import type { McpGrantInput } from "./mcp/policy";
import type { Delivery, DeliverySource } from "./delivery";
import { gcMediaTickets, MediaRepository, type AssetRef } from "./media/repository";
import { createMediaExtension } from "./tools/media";
import { lookupHostMedia } from "./tools/media-host";
import type { McpAuthority } from "./mcp/access";
import type { SubagentCodingOperation, SubagentCapabilityHost } from "./mcp/delegated";
import { DurableObject } from "cloudflare:workers";
import { historyCursor, historyEntry, readHistoryCursor } from "./sessions";
import { ADMIN_PAGE_SIZE } from "./admin/pagination";
import { MemoryManager, type MemoryListQuery, type ProfileProposal } from "./memory/management";
import { importMemoryHistory } from "./memory/history-import";
import { runConsolidate } from "./maintenance/consolidate";
import { generateProfileProposal } from "./maintenance/profile-proposal";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { Type, type Static } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness, InboxDoc, LiveDoc, section, type Conversation, type Registry, type ToolExecutionApi, type SettledSubmissionRecord, type Submission } from "@earendil-works/pi-durable";
import { DurableObjectSqliteDatabase, openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import type { SqliteValue } from "@earendil-works/chord/sqlite";
import type { Env } from "./env";
import { inboundKey, ownerIds, scopeOf, type InboundInput, type Target, type TurnKind } from "./policy";
import { threadOpsSettings, effectiveSettings, type ModelSelection, type Settings, type SettingsSnapshot } from "./settings";
import { MESSAGE_SCHEMA, QQ_CONTEXT_DESCRIPTION, QQ_CONTEXT_PARAMETERS, markMessageRecalled, recordMessage, recall, withReplyContext, type RecallOptions } from "./context";
import { DELEGATION_RULE, EVENT_TURN_IDENTITY, PI_SAFETY_RULE, SEND_RULE, WEB_RULE, subagentTurnIdentity, turnIdentity } from "./prompt";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { modelChange, openModels, sameSelection } from "./models";
import { captureModels } from "./requests/capture";
import { requestTrace } from "./requests/trace";
import { remoteCredentials } from "./model-credentials";
import { MEMORY_SCHEMA } from "./memory/schema";
import { MemoryStore, MemoryStoreError, type Profile } from "./memory/store";
import type { MemoryRow, MemoryInput } from "./memory/types";
import { parseImport } from "./memory/import";
import { createMemoryTools, searchMemory, type MemoryBinding } from "./memory/tools";
import { MEMORY_RULE, type memoryParameters } from "./memory/contracts";
import { renderMemorySection } from "./memory/render";
import { formatBeijingTime } from "./memory/time";
import { MemoryExtractor, directComplete, EXTRACT_ALARM_DELAY_MS, type ExtractComplete } from "./memory/extractor";
import { maintenanceStatus, runMaintenanceJob, type MaintenanceJob, type MaintenanceReport } from "./maintenance";

import { MCP_CATALOG_SCHEMA } from "./mcp/catalog";
import { installCodemode } from "./codemode";
import { createMcpManagementExtension, type McpChange } from "./mcp/manage";
import { ThreadMcp } from "./mcp";
import { createScheduleExtension, type ScheduleAccess } from "./schedule/tools";
import { parseScheduleInputKey } from "./schedule/run";
import type { ScheduleConversation } from "./schedule/types";
import { createGmailTools } from "./gmail/tools";
import type { EventRunStatus } from "./events/model";
import { cleanOutgoing } from "./send-clean";
import { createWebPageTool } from "./tools/web-page";
import { createWebSearchTool } from "./tools/web-search";
import { SkillCatalog } from "./skills";
import { importHistory, importThreadKey, parseMessageImport, type MessageImportResult } from "./message-import";
import { ParentSubagents, SUBAGENT_SCHEMA, type SubagentCaller, type SubagentOrigin, type SubagentView } from "./subagent/parent";
import { subagentName, type SubagentIdentity, type ParentSubagentStatus, type SubagentEntry, type SubagentMeta, type SubagentReport } from "./subagent/model";
import { SandboxTasks, SANDBOX_TASK_SCHEMA, type SandboxTask, type SandboxSubject, type RemoteAction } from "./sandbox/task-access";
import { createCodingExtension } from "./tools/coding";
import { createRemoteSandboxExtension } from "./tools/remote-sandbox";

const context = BACKGROUND_CONTEXT;
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
type InboundRow = {
  message_id: string; platform_message_id: string; user_id: string; self_id: string; text: string; received_at: number;
  status: "queued" | "done" | "failed"; chat_kind: "private" | "group"; chat_id: string; nickname: string;
  persona_text: string | null; session_generation: number; reply_channel: "qq" | "web"; scope_name: string; turn_id: string | null; when_busy: "steer" | "followUp" | null; kind: TurnKind;
};
// 模型可见工具按会话配置生效，只能在会话空闲时切换；不同档位的输入永远不会进入同一个 run。定时输入归 chat 档。
type ToolProfile = "chat" | "event" | "web";
const isWeb = (row: InboundRow) => row.reply_channel === "web";
const isWebAdmin = (row: InboundRow) => isWeb(row) && row.user_id === "admin:web";
const WEB_SEND_RULE = "本轮来自已通过管理口令认证的网页管理员，不是 QQ 消息。与原 QQ 会话共享上下文，但本轮回复只能展示网页。需要回复时调用 send_message，它只把文字和图片资产写入网页，不向 QQ 发送；工作区文件可用 send_file，附件也只展示在网页。不得使用其他工具绕过此回复入口限制。";
const EVENT_MODEL_TOOLS = new Set(["send_message", "qq_context", "mem_search", "gmail_search", "gmail_read", "web_search", "web_page", "read_skill",
  "codemode"]);
const profileOf = (row: InboundRow): ToolProfile => isWeb(row) ? "web" : row.kind === "event" ? "event" : "chat";
type Runtime = { harness: Harness; root: Conversation; registry: Registry; selection: ModelSelection; profile: ToolProfile; mcp?: ThreadMcp };
const targetOf = (row: InboundRow): Target => row.chat_kind === "group" ? { kind: "group", groupId: row.chat_id } : { kind: "private", userId: row.chat_id };
export type EventQuery = { kind?: string; result?: string; before?: number; limit: number };
export type AuditEvent = { id: number; at: number; kind: string; detail: unknown };
// 结果过滤按事件类型取各自的 JSON 字段；表外的类型不参与结果过滤。
const EVENT_RESULT_PATH: Record<string, string> = { mcp_call: "$.result", mcp_catalog: "$.status", web_search: "$.result", generate_image: "$.result",
  web_fetch: "$.result", web_import_image: "$.result",
  coding_exec: "$.result", coding_read: "$.result", coding_write: "$.result", coding_edit: "$.result" };
const SETTINGS_TTL_MS = 60_000;

export class ThreadDO extends DurableObject<Env> {
  private readonly database = new DurableObjectSqliteDatabase(this.ctx.storage);
  private readonly sandboxTasks = new SandboxTasks(this.database);
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
        ${SANDBOX_TASK_SCHEMA}
        CREATE TABLE IF NOT EXISTS session_state (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL);
        INSERT OR IGNORE INTO session_state VALUES (1,0);
        CREATE TABLE IF NOT EXISTS session_resets (request_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, label TEXT NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS outgoing_intents(id TEXT PRIMARY KEY,input_id TEXT NOT NULL,target_json TEXT NOT NULL,text TEXT NOT NULL,assets_json TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS web_outputs (id TEXT PRIMARY KEY, input_id TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL);
      `);
      // 已部署的 P0 表与 submission.requestId 必须保留，新增列用默认值兼容旧回合恢复。
      const columns = await tx.all<{ name: string }>("PRAGMA table_info(inbound)");
      for (const [name, definition] of Object.entries({
        chat_kind: "TEXT NOT NULL DEFAULT 'private'", chat_id: "TEXT NOT NULL DEFAULT ''",
        nickname: "TEXT NOT NULL DEFAULT ''", self_id: "TEXT NOT NULL DEFAULT ''",
        scope_name: "TEXT NOT NULL DEFAULT ''", platform_message_id: "TEXT NOT NULL DEFAULT ''", when_busy: "TEXT", turn_id: "TEXT",
        persona_text: "TEXT", session_generation: "INTEGER NOT NULL DEFAULT 0", kind: "TEXT NOT NULL DEFAULT 'message'", reply_channel: "TEXT NOT NULL DEFAULT 'qq'",
      })) if (!columns.some(column => column.name === name)) await tx.exec(`ALTER TABLE inbound ADD COLUMN ${name} ${definition}`);
      const outboxColumns = await tx.all<{ name: string }>("PRAGMA table_info(outbox)");
      if (!(await tx.all<{ name: string }>("PRAGMA table_info(subagents)")).some(c => c.name === "summary")) await tx.exec("ALTER TABLE subagents ADD COLUMN summary TEXT");
      if (!outboxColumns.some(column => column.name === "turn_id")) await tx.exec("ALTER TABLE outbox ADD COLUMN turn_id TEXT");
      if (!outboxColumns.some(column => column.name === "delivery_id")) await tx.exec("ALTER TABLE outbox ADD COLUMN delivery_id TEXT");
      await tx.exec("CREATE UNIQUE INDEX IF NOT EXISTS outbox_delivery ON outbox(delivery_id)");
      if (!(await tx.all<{name:string}>("PRAGMA table_info(web_outputs)")).some(c=>c.name==="assets_json")) await tx.exec("ALTER TABLE web_outputs ADD COLUMN assets_json TEXT NOT NULL DEFAULT '[]'");
      // 跟进输入会并入同一 Pi run、共用 turn_id；定时运行的发送条数只能按输入计。
      if (!outboxColumns.some(column => column.name === "input_id")) await tx.exec("ALTER TABLE outbox ADD COLUMN input_id TEXT");
      await tx.exec("CREATE INDEX IF NOT EXISTS inbound_turn ON inbound(turn_id); CREATE INDEX IF NOT EXISTS outbox_turn ON outbox(turn_id)");
      await tx.exec("CREATE INDEX IF NOT EXISTS inbound_platform ON inbound(platform_message_id,user_id,chat_kind,chat_id); CREATE INDEX IF NOT EXISTS outbox_message ON outbox(message_id)");
      await tx.run("UPDATE inbound SET chat_id = user_id WHERE chat_id = ''");
      await tx.run("UPDATE inbound SET platform_message_id = message_id WHERE platform_message_id = ''");
    }).then(async () => {
      const ns = await this.namespace();
      if (ns) await new MemoryManager(new MemoryStore(this.database, ns)).recoverInterruptedJobs();
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
    const trace = requestTrace(this.env, await this.namespace(), async (api, c) => {
      const input = await this.currentInput(harness, api, api.conversationId, c);
      return input?.turn_id ? { turnId: input.turn_id, inputId: input.message_id, generation: input.session_generation } : undefined;
    });
    const models = captureModels(this.models(), this.env, this.ctx, { thread: await this.namespace(), actor: "thread", purpose: "conversation" }, trace.binding), selection = (await this.loadSettings(true)).model;
    const memory = new MemoryStore(this.database, await this.namespace());
    // 相同 storage 对象共享事务队列，避免宿主写入被 Pi 的事务一起回滚。
    const storage = await openDurableObjectSqliteStorage(this.ctx.storage, { prefix: "pi_" });
    const registry = createRegistry();
    registry.install(trace.extension);
    registry.install(defineExtension({
      name: "cs-workers",
      sections: [
        section("qq", async (api, callContext) => {
          const input = await this.currentInput(harness, api.read, api.conversationId, callContext);
          return (input && isWeb(input) ? WEB_SEND_RULE : SEND_RULE) + "\n" + WEB_RULE + "\n" + PI_SAFETY_RULE + "\n" + MEMORY_RULE;
        }, { tag: false }),
        section("delegation", async (api, callContext) => {
          const input = await this.currentInput(harness, api.read, api.conversationId, callContext);
          return input?.kind === "message" ? DELEGATION_RULE : undefined;
        }, { tag: false }),
        section("memory", () => renderMemorySection(memory), { tag: false }),
        section("turn-identity", async (api, callContext) => {
          const input = await this.currentInput(harness, api.read, api.conversationId, callContext);
          if (input && isWeb(input)) return WEB_SEND_RULE + "\n当前会话：" + memory.ns + "；管理员权限只作用于本会话范围。";
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
        section("persona", async (api,c) => (await this.currentInput(harness,api.read,api.conversationId,c))?.persona_text || undefined, { tag: false }),
      ],
      tools: [...createMemoryTools(memory, async (api, callContext) => {
        const input = await this.currentInput(harness, api, api.conversationId, callContext);
        return input ? this.memoryBinding(input, memory.ns) : undefined;
      }, { rememberInNamespace: async (ns, input, options, binding) => {
        const source = await this.database.get<InboundRow>("SELECT * FROM inbound WHERE turn_id=? AND platform_message_id=? AND user_id=? ORDER BY rowid DESC LIMIT 1", binding.turnId, binding.messageId, binding.userId);
        if (!source) throw new Error("memory_source_denied");
        return this.env.THREAD.getByName(ns).rememberFromOwner(ns, input, options, { inputId: source.message_id, generation: source.session_generation });
      } }), ...(memory.ns === "owner" ? createGmailTools(async (api, callContext) => {
        const input = await this.currentInput(harness, api, api.conversationId, callContext);
        return input ? this.ownerTurnKind(input) : undefined;
      }, () => this.env.EVENTS.getByName("main")) : []),
      createWebSearchTool(this.env.DEEPSEEK_API_KEY, detail => this.audit("web_search", detail)),
      createWebPageTool(),
      this.skills.tool(),
      defineTool({
        name: "send_message", description: "向本轮回复入口发送文字或私有图片资产。target可填qq:group:ID或qq:private:ID，跨会话须授权；网页回合只显示网页。",
        parameters: Type.Object({ text: Type.String({ maxLength: 4000 }), images: Type.Optional(Type.Array(Type.String({ pattern: "^[a-f0-9]{64}$" }), { maxItems: 5 })), target: Type.Optional(Type.String({ pattern: "^qq:(group|private):[1-9][0-9]{0,19}$" })) }, { additionalProperties: false }),
        // 发 QQ 是外部副作用，中断后禁止自动重放，避免重复发送。
        replay: "unsafe",
        execute: async ({ text, images, target }, api, toolContext) => {
          const input = await this.currentInput(harness, api, api.conversationId, toolContext);
          if (!input) throw new Error("current input missing");
          const repository = new MediaRepository({ bucket: this.env.ASSETS, scope: memory.ns });
          const attachments = await Promise.all((images ?? []).map(async id => { const { ref } = await repository.get(id); if(ref.kind!=="image")throw new Error("unsupported_image"); return ref; }));
          const to: Target | undefined = target ? target.startsWith("qq:group:") ? { kind: "group", groupId: target.slice(9) } : { kind: "private", userId: target.slice(11) } : undefined;
          return { output: [{ type: "text", text: JSON.stringify(await this.deliver(input, cleanOutgoing(text), String(api.taskId), { target: to, attachments })) }] };
        },
      }), defineTool({
        name: "qq_context", description: QQ_CONTEXT_DESCRIPTION + " 主人私聊可显式指定 target 读取其他会话已保存历史；发送授权不授予历史读取权。", parameters: Type.Object({ ...QQ_CONTEXT_PARAMETERS.properties, target: Type.Optional(Type.String({pattern:"^(group|private):[1-9][0-9]{0,19}$"})) }, {additionalProperties:false}),
        replay: "safe",
        execute: async (options, api, toolContext) => {
          const input = await this.currentInput(harness, api, api.conversationId, toolContext);
          if (!input) throw new Error("current input missing");
          const {target,...query}=options;
          let text: string;
          if (target && target !== scopeOf(targetOf(input))) {
            if(isWeb(input)||this.ownerTurnKind(input)!=="message")throw new Error("context_denied");
            const ns=target.startsWith("private:")&&ownerIds(this.env).includes(target.slice(8))?"owner":target;
            text=await this.env.THREAD.getByName(ns).recallForOwner(ns,target,query,{inputId:input.message_id,generation:input.session_generation});
          } else text=await recall(this.database, scopeOf(targetOf(input)), query);
          return { output: [{ type: "text", text }] };
        },
      }), this.subagents.tool(async (api, callContext) => this.subagentCaller(await this.currentInput(harness, api, api.conversationId, callContext)),
        async () => (await this.loadSettings(true)).model)].map(tool => ({ ...tool, callers: ["model"] as const })),
    }));
    const ownerMessageAllowed = async (api: Pick<ToolExecutionApi, "snapshot" | "conversationId">, callContext: Context) => {
      const input = await this.currentInput(harness, api, api.conversationId, callContext);
      return memory.ns === "owner" && !!input && this.ownerTurnKind(input) === "message"
        && input.user_id !== input.self_id && input.session_generation === await this.sessionGeneration();
    };
    const taskAccess = async (api: Pick<ToolExecutionApi, "snapshot" | "conversationId">, callContext: Context) =>
      this.sandboxTaskForInput(await this.currentInput(harness, api, api.conversationId, callContext));
    const remoteSandboxAllowed = async (api: Pick<ToolExecutionApi, "snapshot" | "conversationId">, callContext: Context, action: RemoteAction) =>
      !!(await taskAccess(api, callContext))?.permissions.remote[action];
    const codingAllowed = async (api: Pick<ToolExecutionApi, "snapshot" | "conversationId">, callContext: Context) =>
      !!(await taskAccess(api, callContext))?.permissions.coding;
    // 远程设备与技能发布保留 owner 权限；Linux 工作区按会话隔离，每次嵌套调用复核。
    if (memory.ns === "owner") registry.install(createRemoteSandboxExtension({
      allowed: remoteSandboxAllowed,
      fleet: () => this.env.SANDBOX_FLEET.getByName("owner"), workspace: () => this.env.SANDBOX.idFromName(memory.ns).toString(),
      record: detail => this.audit("remote_sandbox", detail),
    }));
    if (memory.ns === "owner" || memory.ns.startsWith("group:")) registry.install(createCodingExtension({
      allowed: codingAllowed,
      sandbox: () => this.env.SANDBOX.getByName(memory.ns),
      record: (kind, detail) => this.audit(kind, detail),
    }));
    registry.install(createAccessExtension({
      allowManage:async(api,c)=>{
        const input=await this.currentInput(harness,api,api.conversationId,c);
        if(!input||this.ownerTurnKind(input)!=="message"||input.session_generation!==await this.sessionGeneration())return;
        const id=isWebAdmin(input)?ownerIds(this.env)[0]:input.user_id;
        return id?"qq:"+id:undefined;
      },
      registry:()=>this.env.REGISTRY.getByName("main"),bridge:()=>this.env.BRIDGE.getByName("napcat"),
    }));
    registry.install(createWorkspaceAdminExtension({
      allowed: ownerMessageAllowed,
      sandbox:()=>this.env.SANDBOX.getByName(memory.ns),registry:()=>this.env.REGISTRY.getByName("main"),
    }));
    registry.install(createMediaExtension({
      allowed: async (api, c) => { const input = await this.currentInput(harness, api, api.conversationId, c); return !!input && input.session_generation === await this.sessionGeneration() && input.kind === "message"; },
      repository: async () => new MediaRepository({ bucket: this.env.ASSETS, scope: memory.ns }),
      lookup: async (messageId, api, c, selection) => {
        const input = await this.currentInput(harness, api, api.conversationId, c); if (!input) throw new Error("media_scope_denied");
        return lookupHostMedia({ database: this.database, bridge: this.env.BRIDGE.getByName("napcat"), source: { namespace: memory.ns, scope: scopeOf(targetOf(input)), target: targetOf(input) }, messageId, selection });
      },
      sandbox: async () => this.env.SANDBOX.getByName(memory.ns),
      deliver: async (ref, api, c) => { const input = await this.currentInput(harness, api, api.conversationId, c); if(!input)throw new Error("media_scope_denied"); return this.deliver(input,"",String(api.taskId),{attachments:[ref]}); },
      record: (kind, detail) => this.audit(kind, detail),
    }));
    if (memory.ns === "owner" || memory.ns.startsWith("group:")) {
      registry.install(createScheduleExtension(this.env, memory.ns as ScheduleConversation, async (api, callContext) =>
        this.scheduleAccess(await this.currentInput(harness, api, api.conversationId, callContext))));
    }
    const mcp = new ThreadMcp(this.database, this.env, registry, async (api, callContext) => {
      const input = await this.currentInput(harness, api, api.conversationId, callContext);
      return this.mcpAuthority(input);
    }, await this.env.REGISTRY.getByName("main").mcpConfig(), { scope: memory.ns,
      current: (id, digest) => this.env.REGISTRY.getByName("main").mcpServerCurrent(id, digest) });
    await mcp?.restore();
    if (memory.ns === "owner") registry.install(createMcpManagementExtension(this.env,
      async (api, c) => { const input = await this.currentInput(harness, api, api.conversationId, c);
        return !!input && this.ownerTurnKind(input) === "message" && input.session_generation === await this.sessionGeneration(); },
      async refresh => { await mcp.syncConfig(await this.env.REGISTRY.getByName("main").mcpConfig()); if (refresh) await mcp.refreshAll(); },
      change => this.audit("mcp_management", { ...change, source: "agent" })));
    const codemode = installCodemode(registry, {
      allowed: async (api, callContext) => await codingAllowed(api, callContext) || await remoteSandboxAllowed(api, callContext, "view") || await mcp.canUseCodemode(api, callContext),
      namespaces: () => mcp.namespaces(),
    });
    // Codex 默认先走 WebSocket 并按会话缓存连接；DO 里的连接跨不了请求，固定用 SSE。其他 provider 忽略这一项。
    const harness = await Harness.open(storage, { models, registry, settings: { stream: { transport: "sse" } } }, context);
    const root = await harness.root(context, { agent: modelChange(selection) });
    await root.configure(modelChange(selection), context);
    await this.recoverSessionReset(root);
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
    void harness.closed.then(async () => { this.runtime = undefined; await codemode.close(); await mcp?.close(); });
    return runtime;
  }


  /** 网页输出只入本线程；QQ 副作用由 Bridge 的稳定意图负责恢复与防重。 */
  private async deliver(input: InboundRow, text: string, outputId: string, options: { target?: Target; attachments?: AssetRef[] } = {}): Promise<{ status: string; message_id?: string; reason?: string }> {
    if (input.session_generation !== await this.sessionGeneration()) return { status: "rejected", reason: "session_generation_revoked" };
    if (isWeb(input)) {
      if (options.target) return { status: "rejected", reason: "web_reply_only" };
      await this.database.run("INSERT OR IGNORE INTO web_outputs(id,input_id,text,at,assets_json) VALUES(?,?,?,?,?)", outputId, input.message_id, text, Date.now(), JSON.stringify(options.attachments ?? []));
      return { status: "sent", message_id: outputId };
    }
    const thread = await this.namespace(), target = options.target ?? targetOf(input), id = thread + ":" + input.session_generation + ":" + outputId;
    const source = { thread, inputId: input.message_id, generation: input.session_generation, scope: scopeOf(targetOf(input)) };
    if (!await this.validateDeliverySource(source, target)) return { status: "rejected", reason: "send_denied" };
    await this.database.run("INSERT OR IGNORE INTO outgoing_intents(id,input_id,target_json,text,assets_json,state,created_at) VALUES(?,?,?,?,?,'queued',?)",
      id, input.message_id, JSON.stringify(target), text, JSON.stringify(options.attachments ?? []), Date.now());
    const operation = await this.database.get<{created_at:number}>("SELECT created_at FROM outgoing_intents WHERE id=?",id);
    if(!operation)throw new Error("delivery_missing");
    const bridge = this.env.BRIDGE.getByName("napcat");
    let receipt: Delivery | undefined;
    try {
      receipt = await bridge.deliver({ id, operationAt: operation.created_at,
        runId: thread + ":" + (input.turn_id ?? input.message_id), target, text, source, attachments: options.attachments,
        ...(target.kind === "group" && input.kind === "message" && scopeOf(target) === source.scope ? { atUserId: input.user_id } : {}) });
    } catch (error) {
      receipt = await bridge.delivery(id).catch(() => undefined);
      if (!receipt) throw error;
    }
    await this.projectDelivery(receipt);
    return { status: receipt.state, ...(receipt.messageId ? { message_id: receipt.messageId } : {}), ...(receipt.error ? { reason: receipt.error } : {}) };
  }

  async validateDeliverySource(source: DeliverySource, target: Target): Promise<boolean> {
    await this.initialize();
    if (source.thread !== await this.namespace() || source.generation !== await this.sessionGeneration()) return false;
    const input = await this.database.get<InboundRow>("SELECT * FROM inbound WHERE message_id=?", source.inputId);
    if (!input || isWeb(input) || input.session_generation !== source.generation || source.scope !== scopeOf(targetOf(input)) || input.user_id === input.self_id) return false;
    if (scopeOf(target) === source.scope) return true;
    return input.kind === "message" && this.env.REGISTRY.getByName("main").canAccess({ user: "qq:" + input.user_id, cap: "send", scope: source.scope, target: "qq:" + scopeOf(target) });
  }

  private async projectDelivery(receipt: Delivery): Promise<void> {
    await this.database.transaction(async tx => {
      const pending = await tx.get<{ input_id: string; target_json: string; text: string; assets_json: string }>("SELECT * FROM outgoing_intents WHERE id=?", receipt.id);
      if (!pending) return;
      await tx.run("UPDATE outgoing_intents SET state=? WHERE id=?", receipt.state, receipt.id);
      if (receipt.state !== "sent") return;
      const input = await tx.get<InboundRow>("SELECT * FROM inbound WHERE message_id=?", pending.input_id);
      if (!input || await tx.get("SELECT 1 FROM outbox WHERE delivery_id=?", receipt.id)) return;
      await tx.run("INSERT INTO outbox(message_id,text,sent_at,turn_id,input_id,delivery_id) VALUES(?,?,?,?,?,?)", receipt.messageId ?? "", pending.text, receipt.updatedAt, input.turn_id, input.message_id, receipt.id);
      const target: Target = JSON.parse(pending.target_json);
      if (receipt.messageId) await recordMessage(tx, { messageId: receipt.messageId, selfId: input.self_id, userId: input.self_id,
        nickname: "机器人", target, text: pending.text || "[附件]", routeText: pending.text, time: Math.floor(receipt.updatedAt / 1000),
        mentionedSelf: false, replyToId: scopeOf(target) === scopeOf(targetOf(input)) ? input.platform_message_id : null, imageCount: 0, scopeName: input.scope_name }, true);
    });
  }

  async syncDeliveries(): Promise<void> {
    await this.initialize();
    for (const row of await this.database.all<{ id: string }>("SELECT id FROM outgoing_intents WHERE state IN ('queued','sending','unknown') ORDER BY rowid LIMIT 10")) {
      const receipt = await this.env.BRIDGE.getByName("napcat").delivery(row.id);
      if (receipt) await this.projectDelivery(receipt);
    }
  }

  async markRecalled(scope: string, messageId: string): Promise<void> {
    await this.initialize();
    const ns = await this.namespace();
    if (scope !== ns && !(ns === "owner" && scope.startsWith("private:") && ownerIds(this.env).includes(scope.slice(8)))) return;
    await markMessageRecalled(this.database, scope, messageId);
  }

  private audit(kind: string, detail: object): Promise<unknown> {
    return this.database.run("INSERT INTO events(at, kind, detail) VALUES (?, ?, ?)", Date.now(), kind, JSON.stringify(detail));
  }

  private async admit({ harness, root, mcp }: Runtime, row: InboundRow): Promise<Submission> {
    if (mcp) await mcp.syncConfig(await this.env.REGISTRY.getByName("main").mcpConfig());
    if (row.persona_text === null) await this.database.run("UPDATE inbound SET persona_text=? WHERE message_id=? AND persona_text IS NULL", (await this.env.REGISTRY.getByName("main").persona()).text, row.message_id);
    let whenBusy = row.when_busy;
    if (!whenBusy) {
      // 先查排队，再读当前回合；已有他人排队时，后来的同人消息也不能越过队首。
      // 定时与事件输入不插话；它们的回合里来的消息也排到其后，不能并入这些运行。
      const inbox = await harness.snapshot(InboxDoc, root.id, context);
      const active = await this.currentInput(harness, harness, root.id, context);
      whenBusy = !isWeb(row) && row.kind === "message" && active?.kind === "message" && !isWeb(active) && active.user_id === row.user_id && !inbox?.items.some(item => item.mode === "followUp") ? "steer" : "followUp";
      await this.database.run("UPDATE inbound SET when_busy = ? WHERE message_id = ?", whenBusy, row.message_id);
    }
    const content = row.kind === "message" && !isWeb(row)
      ? await withReplyContext(this.database, scopeOf(targetOf(row)), row.platform_message_id, row.text) : row.text;
    return root.submit({ type: "input", content, requestId: row.message_id, whenBusy }, context);
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

  // 只接纳队首连续的同档输入；跨来源等待空闲再切换，防止 QQ 与网页混入同一 run。
  private pump(afterIdle = false): Promise<void> {
    return this.serial(async () => {
      let runtime: Runtime;
      try { runtime = await this.open(); }
      catch(error) {
        const rows=await this.database.all<InboundRow>("SELECT * FROM inbound WHERE status='queued' ORDER BY rowid LIMIT 20");
        for (const row of rows) {
          await this.database.run("UPDATE inbound SET status = 'failed' WHERE message_id = ? AND status = 'queued'", row.message_id);
          this.track(row.message_id, undefined);
          await this.env.REGISTRY.getByName("main").recordTurn({scope:await this.namespace(),origin:isWeb(row)?"web":"qq",
            outcome:error instanceof Error&&/auth|unauthorized|credential/i.test(error.message)?"auth_failed":"failed"}).catch(() => { console.error({ event: "turn_outcome_report_failed" }); });
        }
        return;
      }
      for (;;) {
        const rows = await this.database.all<InboundRow>("SELECT * FROM inbound WHERE status = 'queued' AND when_busy IS NULL ORDER BY rowid");
        const barrier = rows.findIndex(row => profileOf(row) !== runtime.profile);
        const admissible = rows.slice(0, barrier < 0 ? rows.length : barrier);
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
        if (!await tx.get("SELECT 1 FROM inbound WHERE turn_id = ? AND kind = 'message' AND reply_channel = 'qq' LIMIT 1", row.turn_id)) return row;
        await extractor.enqueue(row.turn_id, tx);
        if (await tx.get("SELECT 1 FROM extract_queue LIMIT 1")) await this.wakeBy(Date.now() + EXTRACT_ALARM_DELAY_MS);
        return row;
      });
      if (row) await this.env.REGISTRY.getByName("main").recordTurn({scope:await this.namespace(),origin:isWeb(row)?"web":"qq",outcome:status==="done"?"ok":"failed"}).catch(() => { console.error({ event: "turn_outcome_report_failed" }); });
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
      if (kind === "subagent") {
        const id = /^subagent-report:([0-9a-f-]{36}):/.exec(input.messageId)?.[1];
        const source = id && await this.database.get<{ generation: number | null; status: string }>("SELECT json_extract(origin_json, '$.generation') AS generation,status FROM subagents WHERE id=?", id);
        if (!source || source.status === "cancelled" || source.status === "timeout" || (source.generation ?? 0) !== await this.sessionGeneration()) return;
      }
      // 事件与子 agent 汇报的入站键由投递方生成（来源与外部 id、子 agent 与请求），旧版无 self_id 的兼容判断不适用。
      const key = kind === "event" || kind === "subagent" ? input.messageId : inboundKey(input);
      if (kind !== "event" && kind !== "subagent" && await this.database.get<InboundRow>("SELECT * FROM inbound WHERE message_id = ? AND self_id = '' AND user_id = ?", input.messageId, input.userId)) return;
      const inserted = await this.database.get<InboundRow>(`INSERT OR IGNORE INTO inbound
        (message_id, platform_message_id, user_id, self_id, text, received_at, status, chat_kind, chat_id, nickname, scope_name, kind, reply_channel, session_generation)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, (SELECT generation FROM session_state WHERE id=1)) RETURNING *`, key, input.messageId, input.userId, input.selfId, input.text, input.time,
        input.target.kind, input.target.kind === "group" ? input.target.groupId : input.target.userId, input.nickname, input.scopeName ?? "", kind, input.replyChannel ?? "qq");
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
    const source = await this.database.get<{ generation: number | null }>("SELECT json_extract(origin_json, '$.generation') AS generation FROM subagents WHERE id=?", report.subagentId);
    if (!source || (source.generation ?? 0) !== await this.sessionGeneration()) return "ignored";
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

  private async sandboxTaskForInput(input: InboundRow | undefined): Promise<SandboxTask | undefined> {
    if (!input || !input.turn_id || input.user_id === input.self_id || input.session_generation !== await this.sessionGeneration()) return;
    const scope = await this.namespace(), subject = { scope, actor: input.user_id, generation: input.session_generation,
      replyChannel: input.reply_channel, owner: isWebAdmin(input) ? scope === "owner" : ownerIds(this.env).includes(input.user_id) };
    if (input.kind === "subagent") {
      const id = /^subagent-report:([0-9a-f-]{36}):/.exec(input.message_id)?.[1], access = id ? await this.subagentAccess(id, true) : undefined;
      if (!access?.sandboxTask) return;
      const task = await this.sandboxTasks.resolve(access.sandboxTask.id, subject);
      if (!task) return;
      await this.sandboxTasks.bind(input.message_id, task.id);
      return { ...task, permissions: { coding: task.permissions.coding && !!access.capabilities.coding,
        remote: { view: task.permissions.remote.view && !!access.capabilities.remoteSandbox,
          execute: task.permissions.remote.execute && !!access.capabilities.remoteSandbox, control: task.permissions.remote.control && !!access.capabilities.remoteSandbox } } };
    }
    let id = await this.sandboxTasks.inputTask(input.message_id);
    // 只在可信用户输入上签发；后台输入必须由宿主绑定已有任务，文本不能携带授权。
    if (id === undefined && input.kind === "message") {
      const owner = scope === "owner" && this.ownerTurnKind(input) === "message";
      const coding = owner || scope.startsWith("group:") && input.chat_kind === "group" && scopeOf(targetOf(input)) === scope;
      if (!coding) return;
      const task = await this.sandboxTasks.issue({ sourceInputId: input.message_id, subject, workspace: this.env.SANDBOX.idFromName(scope).toString(),
        permissions: { coding, remote: { view: owner, execute: owner, control: owner } } });
      id = task.id;
    }
    return id ? this.sandboxTasks.resolve(id, subject) : undefined;
  }

  private async mcpAuthority(input: InboundRow | undefined): Promise<McpAuthority | undefined> {
    if (!input?.turn_id || input.session_generation !== await this.sessionGeneration()) return;
    return { kind: input.kind, scope: await this.namespace(), actor: input.user_id, owner: isWebAdmin(input) || ownerIds(this.env).includes(input.user_id),
      generation: input.session_generation, replyChannel: input.reply_channel };
  }

  async validateSubagentAccess(id: string): ReturnType<SubagentCapabilityHost["validateSubagentAccess"]> {
    return this.subagentAccess(id);
  }
  private async subagentAccess(id: string, completed=false): ReturnType<SubagentCapabilityHost["validateSubagentAccess"]> {
    await this.initialize();
    const access = await this.subagents.access(id,completed), as = access?.identity.as;
    if (!access || !as || access.origin.generation === undefined || access.origin.generation !== await this.sessionGeneration()) return;
    const scope = await this.namespace(), capabilities = { ...access.origin.capabilities };
    const subject = { scope, actor: as.userId, owner: as.owner, generation: access.origin.generation, replyChannel: access.origin.replyChannel ?? "qq" } satisfies SandboxSubject;
    // 兼容旧子任务：只从宿主保存且当前仍有效的身份和能力迁移一次授权。
    if (!capabilities.sandboxTask && (capabilities.coding || capabilities.remoteSandbox)) {
      const task = await this.sandboxTasks.issue({ sourceInputId: "legacy-child:" + id, subject, workspace: this.env.SANDBOX.idFromName(scope).toString(),
        permissions: { coding: !!capabilities.coding, remote: { view: !!capabilities.remoteSandbox, execute: !!capabilities.remoteSandbox, control: !!capabilities.remoteSandbox } } });
      capabilities.sandboxTask = task.id;
      await this.database.run("UPDATE subagents SET origin_json=json_set(origin_json,'$.capabilities.sandboxTask',?) WHERE id=?", task.id, id);
    }
    const task = capabilities.sandboxTask ? await this.sandboxTasks.resolve(capabilities.sandboxTask, subject) : undefined;
    capabilities.coding = !!task?.permissions.coding && !!capabilities.coding;
    capabilities.remoteSandbox = !!task?.permissions.remote.view && !!capabilities.remoteSandbox;
    return { ...(task ? { sandboxTask: task } : {}), authority: { kind: "subagent", scope, actor: as.userId, owner: as.owner,
      generation: access.origin.generation, replyChannel: access.origin.replyChannel ?? "qq", subagentId: id }, capabilities };
  }
  async subagentMcp(id: string, call: { name: string; args: unknown; operationId: string }): ReturnType<SubagentCapabilityHost["subagentMcp"]> {
    const access = await this.validateSubagentAccess(id), { mcp } = await this.open();
    if (!access?.capabilities.mcp || !mcp) return { isError: true, output: [{ type: "text", text: "delegation_denied" }] };
    return mcp.invoke({ ...call, operationId: "sub:" + id + ":" + call.operationId, snapshot: access.capabilities.mcp },
      async () => (await this.validateSubagentAccess(id))?.authority);
  }
  async subagentSkill(id: string, input: { name: string; path?: string }): ReturnType<SubagentCapabilityHost["subagentSkill"]> {
    if (!await this.validateSubagentAccess(id)) return { isError: true, output: [{ type: "text", text: "delegation_denied" }] };
    return { output: [{ type: "text", text: await this.skills.read(input.name, input.path) }] };
  }
  async subagentCoding(id: string, operation: SubagentCodingOperation): ReturnType<SubagentCapabilityHost["subagentCoding"]> {
    const access = await this.validateSubagentAccess(id);
    if (!access?.capabilities.coding || !access.authority.owner) return { isError: true, output: [{ type: "text", text: "delegation_denied" }] };
    const name = subagentName(await this.namespace(), id), sandbox = this.env.SANDBOX.getByName(name);
    if (!await this.ctx.storage.get("child-workspace:" + id)) {
      const origin = (await this.subagents.access(id))?.origin, current = await sandbox.snapshot();
      if (!origin) throw new Error("delegation_denied");
      const cloned = await sandbox.cloneFrom({ sourceName: await this.namespace(), expectedRevision: current.revision, sourceRevision: origin.workspaceRevision });
      if (!cloned.ok) throw new Error("workspace_conflict");
      await this.ctx.storage.put("child-workspace:" + id, true);
    }
    const op = operation.kind === "write" ? { kind: "write" as const, path: operation.path, text: operation.content } : operation;
    const result = await sandbox.run({ operationId: "sub:" + id + ":" + operation.operationId, operation: op });
    if (result.status === "committed" && "kind" in result.result && result.result.kind === "image")
      return { output: [{ type: "image", data: result.result.data, mimeType: result.result.mimeType }],
        structuredOutput: { kind: "image", image: { type: "image", data: result.result.data, mimeType: result.result.mimeType } } };
    const value = JSON.stringify(result);
    return { ...(result.status === "committed" ? {} : { isError: true }), output: [{ type: "text", text: value }],
      ...(operation.kind === "read" && result.status === "committed" ? { structuredOutput: { kind: "text", text: value } } : {}) };
  }

  private async subagentCaller(input: InboundRow | undefined): Promise<SubagentCaller | undefined> {
    if (input?.kind !== "message" || !input.turn_id || input.user_id === input.self_id) return;
    const authority = await this.mcpAuthority(input), { mcp } = await this.open();
    const task = await this.sandboxTaskForInput(input), coding = !!task?.permissions.coding && authority?.scope === "owner";
    const snapshot = coding ? await this.env.SANDBOX.getByName(await this.namespace()).snapshot() : undefined;
    const remoteSandbox = !!task?.permissions.remote.view && authority?.scope === "owner";
    const capabilities = { coding, remoteSandbox, ...(task ? { sandboxTask: task.id } : {}), ...(authority && mcp ? { mcp: await mcp.captureCapabilities(authority) } : {}) };
    return { identity: { turn: "message", as: { userId: input.user_id, nickname: input.nickname, owner: isWebAdmin(input) ? this.ctx.id.equals(this.env.THREAD.idFromName("owner")) : ownerIds(this.env).includes(input.user_id), ...(isWebAdmin(input) ? { admin: true as const } : {}) } },
      origin: { capabilities, workspaceRevision: snapshot?.revision, generation: input.session_generation, target: targetOf(input), selfId: input.self_id, scopeName: input.scope_name, ...(isWeb(input) ? { replyChannel: "web" as const } : {}) } };
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
    if (isWebAdmin(input) && this.ctx.id.equals(this.env.THREAD.idFromName("owner"))) return input.kind;
    if (!input.turn_id || input.chat_kind !== "private" || !ownerIds(this.env).includes(input.user_id)) return;
    return input.kind;
  }

  private async scheduleAccess(input: InboundRow | undefined): Promise<ScheduleAccess> {
    if (input && isWebAdmin(input)) return { kind: "manage", actor: "admin:web" };
    if (input?.kind === "schedule") {
      const key = parseScheduleInputKey(input.message_id);
      return key ? { kind: "control", scheduleId: key.scheduleId, fireKey: key.fireKey } : { kind: "none" };
    }
    // 子 agent 汇报回合继承派出者：派出者是确证的 owner 时与其消息回合同权。
    return (input?.kind === "message" || input?.kind === "subagent") && input.user_id !== input.self_id && await this.env.REGISTRY.getByName("main").canAccess({ user: "qq:" + input.user_id, cap: "schedule", scope: scopeOf(targetOf(input)) })
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

  /** 管理员网页输入复用当前 Harness root，但不伪造 QQ 入站或写进 QQ 消息库。 */
  async submitWeb(thread: string, requestId: string, text: string) {
    const key = "web:" + requestId;
    const result = await this.serial(async () => {
      await this.initialize();
      await this.bindNamespace(thread);
      const previous = await this.database.get<InboundRow>("SELECT * FROM inbound WHERE message_id=?", key);
      if (previous) return previous.text === text ? { id: key, status: previous.status, duplicate: true } : { error: "request_conflict" as const };
      const last = await this.database.get<InboundRow>("SELECT * FROM inbound WHERE reply_channel='qq' AND kind='message' ORDER BY rowid DESC LIMIT 1");
      const kind = thread.startsWith("group:") ? "group" : "private";
      const chatId = thread === "owner" ? last?.chat_id ?? ownerIds(this.env)[0] ?? "web" : thread.slice(thread.indexOf(":") + 1);
      await this.database.run("INSERT INTO inbound(message_id,platform_message_id,user_id,self_id,text,received_at,status,chat_kind,chat_id,nickname,scope_name,kind,reply_channel,session_generation) VALUES(?,?,?,?,?,?,'queued',?,?,?,?,'message','web',(SELECT generation FROM session_state WHERE id=1))",
        key, requestId, "admin:web", last?.self_id ?? "", text, Date.now() / 1000, kind, chatId, "网页管理员", last?.scope_name ?? "");
      return { id: key, status: "queued" as const, duplicate: false };
    });
    if (!("error" in result)) this.ctx.waitUntil(this.pump());
    return result;
  }

  /** 只读已提交消息；轮询还会恢复已落库但尚未接纳的网页输入。 */
  async chatView(thread: string, delta?: { after: number; pending: string[] }) {
    await this.initialize();
    await this.bindNamespace(thread);
    type ChatRow = { id: string; role: "user" | "assistant"; source: "qq" | "web"; name: string; text: string; at: number; status: string | null; turnId: string | null; assets_json: string };
    const rows = await this.database.all<ChatRow>(`
      SELECT * FROM (
        SELECT 'qq:' || m.id AS id, CASE WHEN m.is_self=1 THEN 'assistant' ELSE 'user' END AS role,
          'qq' AS source,m.nickname AS name,m.text,m.time * 1000 AS at,i.status,'[]' AS assets_json,
          COALESCE(i.turn_id,(SELECT turn_id FROM outbox WHERE message_id=m.message_id ORDER BY id DESC LIMIT 1)) AS turnId
          FROM messages m LEFT JOIN inbound i ON i.message_id=(SELECT message_id FROM inbound WHERE platform_message_id=m.message_id AND user_id=m.user_id AND chat_kind || ':' || chat_id=m.scope ORDER BY rowid DESC LIMIT 1)
        UNION ALL
        SELECT message_id AS id,'user' AS role,'web' AS source,nickname AS name,text,received_at * 1000 AS at,status,'[]' AS assets_json,turn_id AS turnId
          FROM inbound WHERE reply_channel='web' AND kind='message'
        UNION ALL
        SELECT 'web-out:' || w.id AS id,'assistant' AS role,'web' AS source,'助手' AS name,w.text,w.at,NULL AS status,w.assets_json,i.turn_id AS turnId FROM web_outputs w LEFT JOIN inbound i ON i.message_id=w.input_id
      ) ${delta ? `WHERE at>=?${delta.pending.length ? ` OR id IN (${delta.pending.map(() => "?").join(",")})` : ""}` : ""} ORDER BY at DESC,id DESC LIMIT 100
    `, ...(delta ? [delta.after, ...delta.pending] : []));
    const queued = (await this.database.get<{ n: number }>("SELECT COUNT(*) AS n FROM inbound WHERE status='queued' AND reply_channel='web'"))?.n ?? 0;
    if (queued) this.ctx.waitUntil(this.pump());
    const active = (await this.database.get<{ n: number }>("SELECT COUNT(*) AS n FROM inbound WHERE status='queued'"))?.n ?? 0;
    return { messages: rows.reverse().map(({assets_json,...row})=>({...row,assets:JSON.parse(assets_json) as AssetRef[]})), queued, active, limit: 100, delta: !!delta };
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

  async recallForOwner(ns: string, scope: string, options: RecallOptions, source: {inputId:string;generation:number}):Promise<string> {
    if(!await this.env.THREAD.getByName("owner").validateMemorySource(source))throw new Error("context_denied");
    await this.initialize();await this.bindNamespace(ns);
    if(scope!==ns&&!(ns==="owner"&&scope.startsWith("private:")&&ownerIds(this.env).includes(scope.slice(8))))throw new Error("context_denied");
    return recall(this.database,scope,options);
  }

  async validateMemorySource(source: { inputId: string; generation: number }) {
    await this.initialize();
    if (await this.namespace() !== "owner" || source.generation !== await this.sessionGeneration()) return;
    const input = await this.database.get<InboundRow>("SELECT * FROM inbound WHERE message_id=?", source.inputId);
    if (!input || input.session_generation !== source.generation || isWeb(input) || this.ownerTurnKind(input) !== "message" || input.user_id === input.self_id) return;
    return { author: "qq:" + input.user_id, source_scope: scopeOf(targetOf(input)), source_message_id: input.platform_message_id, source_turn_id: input.turn_id };
  }

  async rememberFromOwner(ns: string, input: Omit<MemoryInput, "ns">, options: { supersedes?: number }, source: { inputId: string; generation: number }): ReturnType<MemoryStore["remember"]> {
    const origin = await this.env.THREAD.getByName("owner").validateMemorySource(source);
    if (!origin) throw new Error("memory_source_denied");
    return (await this.adminStore(ns)).remember({ ...input, ...origin }, options);
  }

  private memoryBinding(input: InboundRow, ns: string): MemoryBinding | undefined {
    if (!input.turn_id) return;
    const owner = isWebAdmin(input) ? ns === "owner" : ownerIds(this.env).includes(input.user_id);
    const expected = isWebAdmin(input) ? ns : owner && input.chat_kind === "private" ? "owner" : scopeOf(targetOf(input));
    if (expected !== ns || input.user_id === input.self_id) return;
    // 事件回合绑定 owner 只为读取范围；写记忆须经主人的一句话，因此不给写权限。
    return { ns, origin: isWeb(input) ? "web" : input.kind, owner: owner && input.kind !== "event", userId: input.user_id, turnId: input.turn_id, scope: scopeOf(targetOf(input)), messageId: input.platform_message_id };
  }

  // 抽取、摘要与整理都是无工具的单次补全，用当前选择的 provider；MEMORY_EXTRACT_MODEL 只换模型 id。
  private readonly complete: ExtractComplete = async (prompt, signal) => {
    const selection = (await this.loadSettings()).model;
    signal.throwIfAborted();
    return directComplete(captureModels(this.models(), this.env, this.ctx, { thread: await this.namespace(), actor: "thread", purpose: "background" }), selection.provider, this.env.MEMORY_EXTRACT_MODEL?.trim() || selection.id)(prompt, signal);
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
    await this.syncDeliveries();
    if(job.kind==="retention")await this.collectAssets();
    const config = threadOpsSettings((await this.env.REGISTRY.getByName("main").opsSettings()).value, await this.namespace());
    if (job.kind === "consolidate" && !config.consolidate) return { kind: "consolidate", status: "skipped" };
    return runMaintenanceJob(job.kind, { db: this.database, kv: this.ctx.storage, store: new MemoryStore(this.database, await this.namespace()),
      complete: this.complete, config, now: job.now });
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

  /** 原始不可变记录仍在 Harness 中；pi.reset 只是新的上下文起点，旧会话可分页浏览。 */
  async sessionHistory(thread: string, cursor?: string): Promise<{ entries: ReturnType<typeof historyEntry>[]; next?: string; busy: boolean; compacting: boolean }> {
    await this.initialize();
    await this.bindNamespace(thread);
    const { root, harness } = await this.open();
    const page = await root.entries({}, ADMIN_PAGE_SIZE, readHistoryCursor(cursor), context);
    const live = await harness.snapshot(LiveDoc, root.id, context);
    return { entries: page.items.map(historyEntry), next: historyCursor(page.next),
      busy: !!live?.run, compacting: (live?.compactions?.length ?? 0) > 0 };
  }

  private async sessionGeneration(): Promise<number> {
    return (await this.database.get<{ generation: number }>("SELECT generation FROM session_state WHERE id=1"))?.generation ?? 0;
  }

  /** 原生 write 的 requestId 是唯一恢复凭据；SQLite 元数据先占新代，恢复时只补同一 reset。 */
  private async recoverSessionReset(root: Conversation): Promise<void> {
    const pending = await this.database.all<{ request_id: string; generation: number; label: string; at: number }>(
      "SELECT * FROM session_resets WHERE status='pending' ORDER BY generation");
    for (const command of pending) {
      await root.submit({ type: "write", requestId: "admin-reset:" + command.request_id,
        entry: { kind: "pi.reset", head: "self", data: { label: command.label, at: command.at, generation: command.generation } } }, context);
      await this.database.run("UPDATE session_resets SET status='done' WHERE request_id=?", command.request_id);
    }
  }

  async resetSession(thread: string, requestId: string, label: string): Promise<{ status: "reset"; generation: number } | { error: "busy" | "request_conflict" }> {
    return this.serial(async () => {
      await this.initialize();
      await this.bindNamespace(thread);
      const normalized = label.trim() || "已归档会话";
      const previous = await this.database.get<{ generation: number; label: string }>("SELECT * FROM session_resets WHERE request_id=?", requestId);
      if (previous && previous.label !== normalized) return { error: "request_conflict" };
      const runtime = await this.open();
      if (previous) { await this.recoverSessionReset(runtime.root); return { status: "reset", generation: previous.generation }; }
      if (!await this.idle(runtime) || await this.database.get("SELECT 1 FROM inbound WHERE status='queued' LIMIT 1")) return { error: "busy" };
      const live = await runtime.harness.snapshot(LiveDoc, runtime.root.id, context);
      if (live?.compactions?.length) return { error: "busy" };
      const generation = await this.sessionGeneration();
      await this.env.BRIDGE.getByName("napcat").cancelQueued({thread,generation});
      // 先取消子任务；并发的迟到汇报会由 generation 检查拒绝。
      await Promise.all((await this.subagents.list()).filter(item => item.status === "running").map(item => this.subagents.cancel(item.id)));
      await this.database.transaction(async tx => {
        await tx.run("INSERT INTO session_resets VALUES (?,?,?,?,'pending')", requestId, generation + 1, normalized, Date.now());
        await tx.run("UPDATE session_state SET generation=? WHERE id=1", generation + 1);
      });
      await this.recoverSessionReset(runtime.root);
      await this.audit("session_reset", { requestId, generation: generation + 1 });
      return { status: "reset", generation: generation + 1 };
    });
  }

  async compactSession(thread: string, instructions?: string): Promise<{ status: "started"; taskId: number } | { error: "busy" }> {
    return this.serial(async () => {
      await this.initialize();
      await this.bindNamespace(thread);
      const { root, harness } = await this.open();
      const live = await harness.snapshot(LiveDoc, root.id, context);
      if (live?.compactions?.length) return { error: "busy" as const };
      const task = await root.compact(instructions, context);
      this.ctx.waitUntil(harness.waitForTask(task, context).then(async result => {
        await this.audit("session_compact", { taskId: Number(task), status: result.state.status });
      }));
      return { status: "started" as const, taskId: Number(task) };
    });
  }

  async stop(): Promise<{ stopped: boolean }> {
    await this.initialize();
    await this.sandboxTasks.revokeAll((await this.database.all<{ message_id: string }>("SELECT message_id FROM inbound WHERE status='queued'")).map(row => row.message_id));
    const children = (await this.subagents.list()).filter(child => child.status === "running");
    await Promise.all(children.map(child => this.subagents.cancel(child.id)));
    if (!await this.database.get("SELECT 1 FROM inbound WHERE status = 'queued' LIMIT 1")) return { stopped: children.length > 0 };
    const idle = (await this.open()).root.abort(context);
    this.ctx.waitUntil(idle);
    // 中止在第一次提交时就已生效；等待 QQ 回执的发送工具要到自身超时才结束，不让管理请求一直挂着。
    await Promise.race([idle, scheduler.wait(2000)]);
    return { stopped: true };
  }



  private async workspaceAdmin(thread:string):Promise<WorkspaceAdminApi>{
    await this.initialize();await this.bindNamespace(thread);
    return createWorkspaceAdminApi({
      authorize:async()=>{},
      current:()=>this.env.SANDBOX.getByName(thread),
      child:async id=>{
        const row=await this.database.get<{origin_json:string;identity_json:string}>("SELECT origin_json,identity_json FROM subagents WHERE id=?",id);
        if(!row||thread!=="owner")throw new Error("workspace_denied");
        const origin=JSON.parse(row.origin_json) as SubagentOrigin,identity=JSON.parse(row.identity_json) as SubagentIdentity;
        if(origin.generation!==await this.sessionGeneration()||!origin.capabilities?.coding||!identity.as?.owner)throw new Error("workspace_denied");
        const sourceName=subagentName(thread,id);
        return {sourceName,sandbox:this.env.SANDBOX.getByName(sourceName)};
      },
    });
  }
  async workspaceFiles(thread:string){return (await this.workspaceAdmin(thread)).list();}
  async workspaceReadBlob(thread:string,input:{path:string;revision:string}){return (await this.workspaceAdmin(thread)).download(input);}
  async workspaceResetRuntime(thread:string){return (await this.workspaceAdmin(thread)).resetRuntime();}
  async workspaceInspectChild(thread:string,input:{childId:string}){return (await this.workspaceAdmin(thread)).inspectChild(input);}
  async workspaceMergeChild(thread:string,input:WorkspaceMergeInput){return (await this.workspaceAdmin(thread)).mergeChild(input);}

  private async collectAssets():Promise<void>{
    const ns=await this.namespace();
    await this.env.SANDBOX.getByName(ns).gc({dryRun:false,batchSize:100});
    const after=await this.ctx.storage.get<number>("asset-gc-child")??0;
    const children=await this.database.all<{rowid:number;id:string}>("SELECT rowid,id FROM subagents WHERE rowid>? ORDER BY rowid LIMIT 5",after);
    for(const child of children)await this.env.SANDBOX.getByName(subagentName(ns,child.id)).gc({dryRun:false,batchSize:100});
    await this.ctx.storage.put("asset-gc-child",children.length===5?children[children.length-1]!.rowid:0);
    if(ns==="owner"){
      const result=await gcMediaTickets(this.env.ASSETS,{limit:1000,cursor:await this.ctx.storage.get<string>("asset-gc-tickets")});
      if(result.cursor)await this.ctx.storage.put("asset-gc-tickets",result.cursor);else await this.ctx.storage.delete("asset-gc-tickets");
    }
  }

  private async adminMcp(scope: string) {
    await this.initialize(); await this.bindNamespace(scope);
    const {mcp}=await this.open(); if(!mcp)throw new Error("mcp_unavailable");
    await mcp.syncConfig(await this.env.REGISTRY.getByName("main").mcpConfig()); return mcp;
  }
  private async mcpReviewer(scope:string):Promise<McpAuthority>{
    return {scope,actor:"admin:web",owner:true,kind:"message",generation:await this.sessionGeneration(),replyChannel:"web"};
  }
  async mcpAccess(scope:string,server:string):ReturnType<McpAdminRpc["mcpAccess"]>{
    return (await (await this.adminMcp(scope)).policy.grant(scope,server))??null;
  }
  async mcpSetAccess(scope:string,server:string,input:McpGrantInput,expected:string):ReturnType<McpAdminRpc["mcpSetAccess"]>{
    const mcp=await this.adminMcp(scope),grant=await mcp.setAccess(scope,server,input,expected,await this.mcpReviewer(scope));
    await mcp.refreshAll(); return grant;
  }
  async mcpApprovals(scope:string):ReturnType<McpAdminRpc["mcpApprovals"]>{
    return (await this.adminMcp(scope)).policy.list(scope);
  }
  async mcpReviewApproval(scope:string,id:string,decision:"approve"|"reject"):ReturnType<McpAdminRpc["mcpReviewApproval"]>{
    const mcp=await this.adminMcp(scope);
    const reviewed = await mcp.reviewApproval(scope,id,decision,await this.mcpReviewer(scope),async original=>{
      if(original.scope!==scope||original.generation!==await this.sessionGeneration())return;
      if(original.subagentId){
        const access=await this.subagentAccess(original.subagentId,true),snapshot=access?.capabilities.mcp;
        return access&&snapshot&&snapshot.scope===original.scope&&snapshot.actor===original.actor&&snapshot.generation===original.generation&&snapshot.replyChannel===original.replyChannel?access.authority:undefined;
      }
      const input=await this.database.get<InboundRow>("SELECT * FROM inbound WHERE user_id=? AND reply_channel=? AND session_generation=? AND kind=? ORDER BY rowid DESC LIMIT 1",original.actor,original.replyChannel,original.generation,original.kind);
      return this.mcpAuthority(input);
    });
    if(!reviewed.result)return {status:reviewed.status};
    return {status:reviewed.status,result:{isError:reviewed.result.isError,output:(reviewed.result.output??[]).map(content=>
      content.type==="text"?{type:"text" as const,text:content.text}:{type:"image" as const,data:content.data,mimeType:content.mimeType})}};
  }

  async refreshMcp(): Promise<{ server: string; status: string; tools: number }[]> {
    const { mcp } = await this.open();
    if (!mcp) throw new Error("mcp_unavailable");
    await mcp.syncConfig(await this.env.REGISTRY.getByName("main").mcpConfig());
    return mcp.refreshAll();
  }

  async recordMcpChange(change: McpChange): Promise<void> {
    await this.initialize();
    await this.audit("mcp_management", { action: change.action, server: change.server, source: "admin" });
  }

  private async adminStore(ns: string): Promise<MemoryStore> {
    await this.initialize();
    await this.bindNamespace(ns);
    return new MemoryStore(this.database, ns);
  }


  async memoryList(ns: string, query: MemoryListQuery): ReturnType<MemoryManager["list"]> {
    return new MemoryManager(await this.adminStore(ns)).list(query);
  }
  async memoryDetail(ns: string, id: number): ReturnType<MemoryManager["detail"]> {
    return new MemoryManager(await this.adminStore(ns)).detail(id);
  }
  async restoreMemory(ns: string, id: number, options: { expectedVersion: number; versionId?: number }): ReturnType<MemoryManager["restore"]> {
    return new MemoryManager(await this.adminStore(ns)).restore(id, options);
  }
  async memoryJobs(ns: string): ReturnType<MemoryManager["jobs"]> {
    return new MemoryManager(await this.adminStore(ns)).jobs();
  }
  async consolidateMemory(ns: string): ReturnType<typeof runConsolidate> {
    const store = await this.adminStore(ns);
    const config = threadOpsSettings((await this.env.REGISTRY.getByName("main").opsSettings()).value, ns);
    return runConsolidate({ db: this.database, kv: this.ctx.storage, store,
      complete: this.complete, config, now: Date.now() });
  }
  async rollbackMemory(ns: string, batchId: string): ReturnType<MemoryManager["rollback"]> {
    return new MemoryManager(await this.adminStore(ns)).rollback(batchId);
  }
  async memoryProposals(ns: string, status: ProfileProposal["status"] | "all"): ReturnType<MemoryManager["proposals"]> {
    return new MemoryManager(await this.adminStore(ns)).proposals(status);
  }
  async generateMemoryProposal(ns: string): ReturnType<typeof generateProfileProposal> {
    return generateProfileProposal(await this.adminStore(ns), this.complete);
  }
  async decideMemoryProposal(ns: string, id: number, decision: "accepted" | "rejected", expectedRevision: string): ReturnType<MemoryManager["decideProposal"]> {
    return new MemoryManager(await this.adminStore(ns)).decideProposal(id, decision, expectedRevision);
  }
  async importMemoryHistory(ns: string, data: unknown, options: { dryRun?: boolean }): ReturnType<typeof importMemoryHistory> {
    return importMemoryHistory(await this.adminStore(ns), data, options);
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

import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import { createRegistry, defineExtension, defineTool, Harness, section, type Conversation, type Registry, type ToolExecutionApi } from '@earendil-works/pi-durable';
import { openDurableObjectSqliteStorage, type DurableObjectSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/cloudflare';
import type { MutableModels } from '@earendil-works/pi-ai/models';
import type { Env } from '../env';
import { ownerIds, scopeOf, type Target, type TurnKind } from '../policy';
import type { Settings, ModelSelection } from '../settings';
import { QQ_CONTEXT_DESCRIPTION, QQ_CONTEXT_PARAMETERS, recall } from '../context';
import { DELEGATION_RULE, EVENT_TURN_IDENTITY, PI_SAFETY_RULE, SEND_RULE, WEB_RULE, subagentTurnIdentity, turnIdentity } from '../prompt';
import { modelChange } from '../models';
import { captureModels } from '../requests/capture';
import { requestTrace } from '../requests/trace';
import { MemoryStore } from '../memory/store';
import { createMemoryTools, type MemoryBinding } from '../memory/tools';
import { MEMORY_RULE } from '../memory/contracts';
import { renderMemorySection } from '../memory/render';
import { formatBeijingTime } from '../memory/time';
import { installCodemode } from '../codemode';
import { createMcpManagementExtension } from '../mcp/manage';
import { ThreadMcp } from '../mcp';
import type { McpAuthority, McpToolSelection } from '../mcp/access';
import { createScheduleExtension, type ScheduleAccess } from '../schedule/tools';
import type { ScheduleConversation } from '../schedule/types';
import { createGmailTools } from '../gmail/tools';
import { cleanOutgoing } from '../send-clean';
import { createWebPageTool } from '../tools/web-page';
import { createImageTool } from '../tools/imagegen';
import { createWebSearchTool } from '../tools/web-search';
import { createAccessExtension } from '../tools/access';
import { createWorkspaceAdminExtension } from '../tools/workspace-admin';
import { createMediaExtension } from '../tools/media';
import { lookupHostMedia } from '../tools/media-host';
import { MediaRepository, type AssetRef } from '../media/repository';
import type { SkillCatalog } from '../skills';
import type { ParentSubagents, SubagentCaller } from '../subagent/parent';
import type { SandboxTask } from '../sandbox/task-access';
import { createCodingExtension } from '../tools/coding';
import { decodeFileRead } from '../sandbox/read';
import { workPath } from '../sandbox/client';
import { workspaceExecutionEnv } from '../sandbox/execution-env';
import { isWeb, isWebAdmin, targetOf, type InboundRow, type ToolProfile } from './model';

const context = BACKGROUND_CONTEXT;
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const WEB_SEND_RULE = "本轮来自已通过管理口令认证的网页管理员，不是 QQ 消息。与原 QQ 会话共享上下文，但本轮回复只能展示网页。需要回复时调用 send_message，它只把文字和图片资产写入网页，不向 QQ 发送；工作区文件可用 send_file，附件也只展示在网页。不得使用其他工具绕过此回复入口限制。";
const EVENT_MODEL_TOOLS = new Set(["send_message", "qq_context", "mem_search", "gmail_search", "gmail_read", "web_search", "web_page", "read_skill",
  "codemode"]);

export type Runtime = { harness: Harness; root: Conversation; registry: Registry; selection: ModelSelection; profile: ToolProfile; mcp?: ThreadMcp; recovered: boolean };

/** 装配模块只能使用显式宿主能力；执行状态、准入队列和 alarm 仍由 ThreadDO 拥有。 */
export interface ThreadRuntimeHost {
  env: Env;
  ctx: DurableObjectState;
  observedStorage: DurableObjectStorage;
  database: DurableObjectSqliteDatabase;
  skills: SkillCatalog;
  subagents: ParentSubagents;
  namespace(): Promise<string>;
  models(): MutableModels;
  loadSettings(fresh?: boolean): Promise<Settings>;
  installProjection(): void;
  currentInput(harness: Harness, read: Pick<Harness, 'snapshot'>, conversationId: Conversation['id'], context: Context): Promise<InboundRow | undefined>;
  memoryBinding(input: InboundRow, namespace: string): MemoryBinding | undefined;
  sessionGeneration(): Promise<number>;
  ownerTurnKind(input: InboundRow): TurnKind | undefined;
  sandboxTaskForInput(input: InboundRow | undefined): Promise<SandboxTask | undefined>;
  subagentCaller(input: InboundRow | undefined, selection: { sandboxId?: string; mcpTools?: McpToolSelection }): Promise<SubagentCaller | undefined>;
  scheduleAccess(input: InboundRow | undefined): Promise<ScheduleAccess>;
  mcpAuthority(input: InboundRow | undefined): Promise<McpAuthority | undefined>;
  deliver(input: InboundRow, text: string, outputId: string, options?: { target?: Target; attachments?: AssetRef[] }): Promise<{ status: string; message_id?: string; reason?: string }>;
  audit(kind: string, detail: object): Promise<unknown>;
  runtimeWake(wake: ReturnType<Harness['wake']>): Promise<void>;
  closed(): void;
}

export async function applyToolProfile(runtime: Runtime, profile: ToolProfile, storage: DurableObjectStorage): Promise<void> {
  const tools = new Map(runtime.registry.snapshot().tools().map(({ tool }) => [tool.name, tool]));
  await runtime.root.configure({ modelTools: profile === "event" ? [...tools.values()].filter(tool => EVENT_MODEL_TOOLS.has(tool.name)) : null }, context);
  await storage.put("tool_profile", profile);
  runtime.profile = profile;
}


/** 只装配暂停中的 Harness；不得在只读打开时触发模型执行。 */
export async function openThreadRuntime(host: ThreadRuntimeHost): Promise<Runtime> {
  const trace = requestTrace(host.env, await host.namespace(), async (api, c) => {
    const input = await host.currentInput(harness, api, api.conversationId, c);
    return input?.turn_id ? { turnId: input.turn_id, inputId: input.message_id, generation: input.session_generation } : undefined;
  });
  const models = captureModels(host.models(), host.env, host.ctx, { thread: await host.namespace(), actor: "thread", purpose: "conversation" }, trace.binding), selection = (await host.loadSettings(true)).model;
  const memory = new MemoryStore(host.database, await host.namespace());
  // 相同 storage 对象共享事务队列，避免宿主写入被 Pi 的事务一起回滚。
  const storage = await openDurableObjectSqliteStorage(host.observedStorage, { prefix: "pi_" });
  host.installProjection();
  const registry = createRegistry();
  registry.install(trace.extension);
  registry.install(defineExtension({
    name: "cs-workers",
    sections: [
      section("qq", async (api, callContext) => {
        const input = await host.currentInput(harness, api.read, api.conversationId, callContext);
        return (input && isWeb(input) ? WEB_SEND_RULE : SEND_RULE) + "\n" + WEB_RULE + "\n" + PI_SAFETY_RULE + "\n" + MEMORY_RULE;
      }, { tag: false }),
      section("delegation", async (api, callContext) => {
        const input = await host.currentInput(harness, api.read, api.conversationId, callContext);
        return input?.kind === "message" ? DELEGATION_RULE : undefined;
      }, { tag: false }),
      section("memory", () => renderMemorySection(memory), { tag: false }),
      section("turn-identity", async (api, callContext) => {
        const input = await host.currentInput(harness, api.read, api.conversationId, callContext);
        if (input && isWeb(input)) return WEB_SEND_RULE + "\n当前会话：" + memory.ns + "；管理员权限只作用于本会话范围。";
        if (input?.kind === "event") return EVENT_TURN_IDENTITY;
        if (input?.kind === "subagent") return subagentTurnIdentity({ userId: input.user_id, nickname: input.nickname, target: targetOf(input), scopeName: input.scope_name },
          ownerIds(host.env).includes(input.user_id));
        return input ? turnIdentity({ userId: input.user_id, nickname: input.nickname, target: targetOf(input), scopeName: input.scope_name }, ownerIds(host.env).includes(input.user_id)) : undefined;
      }, { tag: false }),
      // 模型没有时钟；按本轮输入的到达时刻给时间，同一回合内文本不变，不打散提示缓存。
      section("time", async (api, callContext) => {
        const input = await host.currentInput(harness, api.read, api.conversationId, callContext);
        if (!input) return undefined;
        const ms = input.received_at < 1e12 ? input.received_at * 1000 : input.received_at;
        return `现在是北京时间 ${formatBeijingTime(ms)}（${WEEKDAYS[new Date(ms + 8 * 3600_000).getUTCDay()]}）；今天、明天、下周这类相对时间都按北京时间理解。`;
      }, { tag: false }),
      section("skills", () => host.skills.section(), { tag: false }),
      section("persona", async (api,c) => (await host.currentInput(harness,api.read,api.conversationId,c))?.persona_text || undefined, { tag: false }),
    ],
    tools: [...createMemoryTools(memory, async (api, callContext) => {
      const input = await host.currentInput(harness, api, api.conversationId, callContext);
      return input ? host.memoryBinding(input, memory.ns) : undefined;
    }, { rememberInNamespace: async (ns, input, options, binding) => {
      const source = await host.database.get<InboundRow>("SELECT * FROM inbound WHERE turn_id=? AND platform_message_id=? AND user_id=? ORDER BY rowid DESC LIMIT 1", binding.turnId, binding.messageId, binding.userId);
      if (!source) throw new Error("memory_source_denied");
      return host.env.THREAD.getByName(ns).rememberFromOwner(ns, input, options, { inputId: source.message_id, generation: source.session_generation });
    } }), ...(memory.ns === "owner" ? createGmailTools(async (api, callContext) => {
      const input = await host.currentInput(harness, api, api.conversationId, callContext);
      return input ? host.ownerTurnKind(input) : undefined;
    }, () => host.env.EVENTS.getByName("main")) : []),
    createWebSearchTool(host.env.DEEPSEEK_API_KEY, detail => host.audit("web_search", detail)),
    createWebPageTool(),
    createImageTool({ models: host.models(), repository: new MediaRepository({ bucket: host.env.ASSETS, scope: memory.ns }),
      allowed: async (api, c) => { const input = await host.currentInput(harness, api, api.conversationId, c); return !!input && input.kind === "message" && input.session_generation === await host.sessionGeneration(); },
      record: detail => host.audit("generate_image", detail),
    }),
    host.skills.tool(),
    defineTool({
      name: "send_message", description: "向本轮回复入口发送文字或私有图片资产。target可填qq:group:ID或qq:private:ID，跨会话须授权；网页回合只显示网页。",
      parameters: Type.Object({ text: Type.String({ maxLength: 4000 }), images: Type.Optional(Type.Array(Type.String({ pattern: "^[a-f0-9]{64}$" }), { maxItems: 5 })), target: Type.Optional(Type.String({ pattern: "^qq:(group|private):[1-9][0-9]{0,19}$" })) }, { additionalProperties: false }),
      // 发 QQ 是外部副作用，中断后禁止自动重放，避免重复发送。
      replay: "unsafe",
      execute: async ({ text, images, target }, api, toolContext) => {
        const input = await host.currentInput(harness, api, api.conversationId, toolContext);
        if (!input) throw new Error("current input missing");
        const repository = new MediaRepository({ bucket: host.env.ASSETS, scope: memory.ns });
        const attachments = await Promise.all((images ?? []).map(async id => { const { ref } = await repository.get(id); if(ref.kind!=="image")throw new Error("unsupported_image"); return ref; }));
        const to: Target | undefined = target ? target.startsWith("qq:group:") ? { kind: "group", groupId: target.slice(9) } : { kind: "private", userId: target.slice(11) } : undefined;
        return { output: [{ type: "text", text: JSON.stringify(await host.deliver(input, cleanOutgoing(text), String(api.taskId), { target: to, attachments })) }] };
      },
    }), defineTool({
      name: "qq_context", description: QQ_CONTEXT_DESCRIPTION + " 主人私聊可显式指定 target 读取其他会话已保存历史；发送授权不授予历史读取权。", parameters: Type.Object({ ...QQ_CONTEXT_PARAMETERS.properties, target: Type.Optional(Type.String({pattern:"^(group|private):[1-9][0-9]{0,19}$"})) }, {additionalProperties:false}),
      replay: "safe",
      execute: async (options, api, toolContext) => {
        const input = await host.currentInput(harness, api, api.conversationId, toolContext);
        if (!input) throw new Error("current input missing");
        const {target,...query}=options;
        let text: string;
        if (target && target !== scopeOf(targetOf(input))) {
          if(isWeb(input)||host.ownerTurnKind(input)!=="message")throw new Error("context_denied");
          const ns=target.startsWith("private:")&&ownerIds(host.env).includes(target.slice(8))?"owner":target;
          text=await host.env.THREAD.getByName(ns).recallForOwner(ns,target,query,{inputId:input.message_id,generation:input.session_generation});
        } else text=await recall(host.database, scopeOf(targetOf(input)), query);
        return { output: [{ type: "text", text }] };
      },
    }), host.subagents.tool(async (api, callContext, selection) => host.subagentCaller(await host.currentInput(harness, api, api.conversationId, callContext), selection),
      async () => (await host.loadSettings(true)).model)].map(tool => ({ ...tool, callers: ["model"] as const })),
  }));
  const ownerTaskAllowed = async (api: Pick<ToolExecutionApi, "snapshot" | "conversationId">, callContext: Context) => {
    const input = await host.currentInput(harness, api, api.conversationId, callContext);
    if(memory.ns!=="owner"||!input||(input.kind!=="message"&&input.kind!=="subagent"))return false;
    const task=await host.sandboxTaskForInput(input);
    if(!task?.subject.owner||!task.permissions.coding)return false;
    // 续轮必须追溯真实主人输入；复用任务撤销、身份、回复入口和会话代次检查。
    const source=await host.database.get<InboundRow>("SELECT * FROM inbound WHERE message_id=?",task.sourceInputId);
    return !!source&&host.ownerTurnKind(source)==="message"&&source.user_id!==source.self_id
      &&source.user_id===task.subject.actor&&source.reply_channel===task.subject.replyChannel
      &&source.session_generation===task.subject.generation;
  };
  const taskAccess = async (api: Pick<ToolExecutionApi, "snapshot" | "conversationId">, callContext: Context) =>
    host.sandboxTaskForInput(await host.currentInput(harness, api, api.conversationId, callContext));
  const codingAllowed = async (api: Pick<ToolExecutionApi, "snapshot" | "conversationId">, callContext: Context) =>
    !!(await taskAccess(api, callContext))?.permissions.coding;
  const resources = host.env.CLOUDFLARE_WORKSPACE_RESOURCES.getByName("owner");
  const workspaceFor = async (id?: string) => {
    if (!id) return host.env.SANDBOX.getByName(memory.ns);
    const resource = await resources.get(memory.ns, id);
    if (!resource) throw new Error("invalid_request");
    return host.env.SANDBOX.getByName(resource.name);
  };
  if (memory.ns === "owner" || memory.ns.startsWith("group:")) registry.install(createCodingExtension({
    allowed: codingAllowed,
    ...(memory.ns === "owner" ? { resources: {
      allowed: ownerTaskAllowed,
      list: () => resources.list(memory.ns),
      create: (operationId, input) => resources.create(memory.ns, operationId, input),
    } } : {}),
    sandbox: workspaceFor,
    readWorkspace: async ({ workspace, path, ...options }, api, context) => {
      if (!await ownerTaskAllowed(api, context)) throw new Error("permission_denied");
      const file = await host.env.SANDBOX.getByName(workspace).readBlob(workPath(path));
      return decodeFileRead(file.bytes, options);
    },
    record: (kind, detail) => host.audit(kind, detail),
  }));
  registry.install(createAccessExtension({
    allowManage:async(api,c)=>{
      const input=await host.currentInput(harness,api,api.conversationId,c);
      if(!input||host.ownerTurnKind(input)!=="message"||input.session_generation!==await host.sessionGeneration())return;
      const id=isWebAdmin(input)?ownerIds(host.env)[0]:input.user_id;
      return id?"qq:"+id:undefined;
    },
    registry:()=>host.env.REGISTRY.getByName("main"),bridge:()=>host.env.BRIDGE.getByName("napcat"),
  }));
  registry.install(createWorkspaceAdminExtension({
    allowed: ownerTaskAllowed,
    sandbox:()=>host.env.SANDBOX.getByName(memory.ns),registry:()=>host.env.REGISTRY.getByName("main"),
  }));
  registry.install(createMediaExtension({
    allowed: async (api, c, kind) => {
      const input = await host.currentInput(harness, api, api.conversationId, c);
      if (!input || input.session_generation !== await host.sessionGeneration()) return false;
      return input.kind === "message" || kind === "media_send" && input.kind === "subagent" && await ownerTaskAllowed(api, c);
    },
    repository: async () => new MediaRepository({ bucket: host.env.ASSETS, scope: memory.ns }),
    lookup: async (messageId, api, c, selection) => {
      const input = await host.currentInput(harness, api, api.conversationId, c); if (!input) throw new Error("media_scope_denied");
      return lookupHostMedia({ database: host.database, bridge: host.env.BRIDGE.getByName("napcat"), source: { namespace: memory.ns, scope: scopeOf(targetOf(input)), target: targetOf(input) }, messageId, selection });
    },
    sandbox: async (api, callContext, sandboxId) => {
      if (sandboxId !== undefined && !await ownerTaskAllowed(api, callContext)) throw new Error("permission_denied");
      return workspaceFor(sandboxId);
    },
    deliver: async (ref, api, c) => { const input = await host.currentInput(harness, api, api.conversationId, c); if(!input)throw new Error("media_scope_denied"); return host.deliver(input,"",String(api.taskId),{attachments:[ref]}); },
    record: (kind, detail) => host.audit(kind, detail),
  }));
  if (memory.ns === "owner" || memory.ns.startsWith("group:")) {
    registry.install(createScheduleExtension(host.env, memory.ns as ScheduleConversation, async (api, callContext) =>
      host.scheduleAccess(await host.currentInput(harness, api, api.conversationId, callContext))));
  }
  const mcp = new ThreadMcp(host.database, host.env, registry, async (api, callContext) => {
    const input = await host.currentInput(harness, api, api.conversationId, callContext);
    return host.mcpAuthority(input);
  }, await host.env.REGISTRY.getByName("main").mcpConfig(), { scope: memory.ns, callerNamespace: host.ctx.id.toString(),
    current: (id, digest) => host.env.REGISTRY.getByName("main").mcpServerCurrent(id, digest) });
  await mcp?.restore();
  if (memory.ns === "owner") registry.install(createMcpManagementExtension(host.env,
    async (api, c) => { const input = await host.currentInput(harness, api, api.conversationId, c);
      return !!input && host.ownerTurnKind(input) === "message" && input.session_generation === await host.sessionGeneration(); },
    async refresh => { await mcp.syncConfig(await host.env.REGISTRY.getByName("main").mcpConfig()); if (refresh) await mcp.refreshAll(); },
    change => host.audit("mcp_management", { ...change, source: "agent" })));
  const codemode = installCodemode(registry, {
    allowed: async (api, callContext) => await codingAllowed(api, callContext) || await mcp.canUseCodemode(api, callContext),
    namespaces: () => mcp.namespaces(),
  });
  // Codex 默认先走 WebSocket 并按会话缓存连接；DO 里的连接跨不了请求，固定用 SSE。其他 provider 忽略这一项。
  const harness = await Harness.open(storage, { models, registry, settings: { stream: { transport: "sse" } },
    env: target => workspaceExecutionEnv({ id: "cloudflare:" + host.env.SANDBOX.idFromName(memory.ns), cwd: target.cwd,
      files: async callContext => {
        if (!await codingAllowed({ conversationId: target.conversationId, snapshot: target.read.snapshot.bind(target.read) }, callContext)) throw new Error("permission_denied");
        return workspaceFor();
      },
    }),
    onWake: wake => host.ctx.waitUntil(host.runtimeWake(wake)),
  }, context);
  const root = await harness.root(context, { agent: modelChange(selection) });
  await root.configure(modelChange(selection), context);
  const runtime: Runtime = { harness, root, registry, selection, profile: "chat", mcp, recovered: false };
  await applyToolProfile(runtime, await host.ctx.storage.get<ToolProfile>("tool_profile") ?? "chat", host.ctx.storage);
  // 快照先装配，远端离线不阻塞 Harness 恢复；首次执行仍强制核对完整目录。
  if (mcp) host.ctx.waitUntil(mcp.refreshAll().then(() => {}));
  // 只读打开保持暂停；提交、等待与恢复都由 alarm 进入，不能在查看历史时启动模型。
  void harness.closed.then(async () => { host.closed(); await codemode.close(); await mcp?.close(); });
  return runtime;
}

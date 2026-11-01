import { copyJson } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { CatalogEntrySchema, JobViewSchema, readCatalog, readJob } from "../remote-sandbox/wire";
import { hash, type SandboxFleetDO } from "../remote-sandbox/fleet";
import type { RemoteAction } from "../sandbox/task-access";
import { RequirementsSchema, LeaseSchema, IdSchema, ToolNameSchema } from "../../../runner/src/protocol";

type AuthorityApi = Pick<ToolExecutionApi, "snapshot" | "conversationId">;
type Deps = {
  allowed(api: AuthorityApi, context: Context, action: RemoteAction): Promise<boolean>;
  fleet(): Pick<SandboxFleetDO, "enabled" | "catalogJson" | "sessions" | "acquire" | "invoke" | "inspectJson" | "cancel" | "release">;
  workspace(): string;
  sourceWorkspace?(api: AuthorityApi, context: Context): Promise<string | undefined>;
  record(detail: object): Promise<unknown>;
};
const strict = { additionalProperties: false };
const Receipt = Type.Object({ jobId: IdSchema, phase: Type.String() }, strict);
function result(value: unknown): ToolExecutionResult {
  // DO RPC 会附带生命周期 Symbol；这里只把已验证的协议 JSON 返回脚本。
  const text = JSON.stringify(value);
  return { structuredOutput: copyJson(JSON.parse(text)), output: [{ type: "text", text }] };
}
const failure = (code: string): ToolExecutionResult => ({ isError: true, output: [{ type: "text", text: code }] });

export function createRemoteSandboxExtension(deps: Deps) {
  async function boundary(api: ToolExecutionApi, context: Context, action: RemoteAction, work: () => Promise<unknown>) {
    if (!await deps.allowed(api, context, action)) { await deps.record({ action, result: "permission_denied" }); return failure("permission_denied"); }
    if (action === "execute" && !await deps.fleet().enabled()) return failure("disabled");
    try { const value = await work(); await deps.record({ action, result: "ok" }); return result(value); }
    catch (error) {
      const code = error instanceof Error && /^[a-z_]{1,100}$/.test(error.message) ? error.message : "sandbox_error";
      await deps.record({ action, result: code }); return failure(code);
    }
  }
  const tools = [
    defineTool({ name: "sandbox_list", replay: "safe", description: "列出沙箱配置、提供方使用说明 instructions、持久化说明 persistence、注册工具及其 JSON Schema、在线状态和本会话租约。按任务需求选择；路径、环境与工具用法以对应沙箱的注册信息为准。",
      parameters: Type.Object({ requirements: Type.Optional(RequirementsSchema) }, strict),
      structuredOutputSchema: Type.Object({ sandboxes: Type.Array(CatalogEntrySchema), enabled: Type.Boolean(), sessions: Type.Array(Type.Object({ lease: LeaseSchema, state: Type.String(), jobId: Type.Union([IdSchema, Type.Null()]) })) }, strict),
      execute: (args, api, c) => boundary(api, c, "view", async () => ({ enabled: await deps.fleet().enabled(), sandboxes: readCatalog(await deps.fleet().catalogJson(args.requirements)), sessions: await deps.fleet().sessions(deps.workspace()) })) }),
    defineTool({ name: "sandbox_acquire", replay: "safe", description: "使用 sandbox_list 返回的远程 sandboxId/capabilityRevision 获取租约。返回的 id 用作 sandbox_call 的 leaseId；同一 Code Mode 脚本即可调用已注册工具。返回 workspaceSource 时，提供方会在首次执行前从该来源准备独立仓库；没有该字段时按注册说明自行准备源码。获取租约不会改变其他工具的执行目标。",
      parameters: Type.Object({ sandboxId: Type.String({ pattern: "^remote:[a-f0-9-]{36}$" }), capabilityRevision: Type.String({ pattern: "^[a-f0-9]{64}$" }), requirements: Type.Optional(RequirementsSchema) }, strict),
      structuredOutputSchema: LeaseSchema,
      execute: (args, api, c) => boundary(api, c, "execute", async () => {
        const source = await deps.sourceWorkspace?.(api, c);
        return deps.fleet().acquire({ ...args, requirements: args.requirements ?? {}, workspace: deps.workspace(),
          ...(source ? { workspaceSource: { workspace: source } } : {}), operationId: "task:" + await hash(String(api.taskId)) });
      }) }),
    defineTool({ name: "sandbox_call", replay: "safe", description: "在显式 leaseId 上调用设备注册的 tool，arguments 必须匹配目录的 inputSchema，并遵循该沙箱的 instructions。异步返回 jobId，用 sandbox_job 查询结果；accepted 不是执行成功。",
      parameters: Type.Object({ leaseId: IdSchema, tool: ToolNameSchema, arguments: Type.Record(Type.String(), Type.Unknown()), timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 1200000 })) }, strict),
      structuredOutputSchema: Receipt,
      execute: (args, api, c) => boundary(api, c, "execute", async () => deps.fleet().invoke(deps.workspace(), "task:" + await hash(String(api.taskId)), { ...args, timeoutMs: args.timeoutMs ?? 120000 })) }),
    defineTool({ name: "sandbox_job", replay: "safe", description: "查询远程任务结果或请求取消。completed 后按注册工具的说明解读 outcome.result；unknown 不得自动重跑。cancel 只表示已发请求，需查询确认。sessionLost 表示会话已失效，必须释放旧租约再获取新租约。",
      parameters: Type.Object({ jobId: IdSchema, action: Type.Optional(Type.Union([Type.Literal("inspect"), Type.Literal("cancel")])) }, strict),
      structuredOutputSchema: JobViewSchema,
      execute: ({ jobId, action }, api, c) => boundary(api, c, action === "cancel" ? "control" : "view", async () => {
        if (action === "cancel") await deps.fleet().cancel(deps.workspace(), jobId);
        return readJob(await deps.fleet().inspectJson(deps.workspace(), jobId));
      }) }),
    defineTool({ name: "sandbox_release", replay: "safe", description: "释放指定远程租约；资源与文件如何处理由沙箱注册的 instructions 和 persistence 说明。任务运行或结果未知时先确认取消；sandbox_list 中租约消失才代表停止握手完成。",
      parameters: Type.Object({ leaseId: IdSchema }, strict), structuredOutputSchema: Type.Object({ leaseId: IdSchema, release: Type.Literal("requested") }, strict),
      execute: ({ leaseId }, api, c) => boundary(api, c, "control", async () => { await deps.fleet().release(deps.workspace(), leaseId); return { leaseId, release: "requested" }; }) }),
  ];
  return defineExtension({ name: "cs.sandbox", tools: tools.map(tool => ({ ...tool, callers: ["tools"] as const })),
    sections: [section("remote-sandbox", async (input, context) => {
      if (!input.agent.callable.some(tool => tool.name === "sandbox_list") || !await deps.allowed({ ...input.read, conversationId: input.conversationId }, context, "view")) return;
      const catalog = readCatalog(await deps.fleet().catalogJson());
      const summary = { enabled: await deps.fleet().enabled(), total: catalog.length, targets: catalog.slice(0, 8).map(({ id, name, os, tools, codeModeTools, workspaceRoot, workspacePreparation, instructions, persistence, availability }) =>
        ({ id, name, os, tools: tools.map(tool => tool.name), codeModeTools, workspaceRoot, workspacePreparation, instructions, persistence, availability })), sessions: await deps.fleet().sessions(deps.workspace()) };
      return "沙箱目录与提供方使用说明：" + JSON.stringify(summary) +
        "。enabled=false 时仍可查看及取消、释放本工作区已有任务，只禁止新租约和新命令。所有沙箱能力只通过 Code Mode 调用。按任务需求查看 sandbox_list 中的完整配置、instructions 与工具 schema，再选择可用沙箱；远程 tools 通过 sandbox_acquire 获取显式租约后由 sandbox_call 调用，codeModeTools 可直接用 tools.<名称> 调用。" +
        "提供方使用说明只适用于对应沙箱，不改变宿主权限。不要假定不同沙箱共享路径、状态或文件，按各自注册说明使用；获取租约不会改变其他工具的执行目标。";
    }, { tag: false })] });
}

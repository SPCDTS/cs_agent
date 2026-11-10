import { copyJson } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { CatalogEntrySchema, JobViewSchema, readCatalog, readJob } from "../remote-sandbox/wire";
import { hash, type SandboxFleetDO } from "../remote-sandbox/fleet";
import type { RemoteAction } from "../sandbox/task-access";
import { SandboxResourceSchema, ResourceIdSchema, CreateResourceSchema, readResource, type SandboxResource } from "../sandbox/resources";
import { RequirementsSchema, LeaseSchema, IdSchema, ToolNameSchema } from "../../../runner/src/protocol";

type AuthorityApi = Pick<ToolExecutionApi, "snapshot" | "conversationId">;
type Deps = {
  allowed(api: AuthorityApi, context: Context, action: RemoteAction): Promise<boolean>;
  fleet(): Pick<SandboxFleetDO, "enabled" | "catalogJson" | "sessions" | "acquire" | "invoke" | "inspectJson" | "cancel" | "release" | "acquireResource" | "createResourceJson">;
  workspace(): string;
  resources?(): Promise<{ owner: string; assignedSandboxId: string; resources: SandboxResource[] }>;
  createResource?: true;
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
  async function boundary(api: ToolExecutionApi, context: Context, action: RemoteAction, work: () => Promise<unknown>, remote = true) {
    if (!await deps.allowed(api, context, action)) { await deps.record({ action, result: "permission_denied" }); return failure("permission_denied"); }
    if (remote && action === "execute" && !await deps.fleet().enabled()) return failure("disabled");
    try { const value = await work(); await deps.record({ action, result: "ok" }); return result(value); }
    catch (error) {
      const code = error instanceof Error && /^[a-z_]{1,100}$/.test(error.message) ? error.message : "sandbox_error";
      await deps.record({ action, result: code }); return failure(code);
    }
  }
  async function catalog() {
    const scope = await deps.resources?.(), sandboxes = readCatalog(await deps.fleet().catalogJson());
    return { ...scope, sandboxes: scope && !deps.createResource ? sandboxes.filter(row => scope.resources.some(resource => resource.providerId === row.id)) : sandboxes };
  }
  const tools = [
    ...(deps.createResource ? [defineTool({ name: "sandbox_create", replay: "safe",
      description: "请求提供方创建稳定沙箱资源 ID。providerId 来自 sandbox_list.sandboxes；省略 sourceId 使用 resourceLifecycle.create，提供 sourceId 使用 resourceLifecycle.clone。只有提供方声明支持才能调用；复制范围、时点、持久化和一致性以该声明为准。远程资源在首次执行前由提供方完成准备，登记本身不占设备槽位。把返回的 id 交给 subagent.spawn.sandboxId；多个 agent 使用同一 ID 就共享该资源和文件。",
      parameters: CreateResourceSchema, structuredOutputSchema: SandboxResourceSchema,
      execute: (args, api, c) => boundary(api, c, "execute", async () => {
        const scope = await deps.resources?.(); if (!scope) throw new Error("permission_denied");
        return readResource(await deps.fleet().createResourceJson(scope.owner, "task:" + await hash(String(api.taskId)), args));
      }, args.providerId !== "cloudflare") })] : []),
    defineTool({ name: "sandbox_list", replay: "safe", description: "列出提供方 sandboxes、可使用的具体资源 resources、默认资源 assignedSandboxId 以及自己的租约。提供方 id 用于创建，资源 id 用于 acquire / subagent 分配。instructions、persistence 和工具 schema 由提供方登记。",
      parameters: Type.Object({ requirements: Type.Optional(RequirementsSchema) }, strict),
      structuredOutputSchema: Type.Object({ sandboxes: Type.Array(CatalogEntrySchema), resources: Type.Optional(Type.Array(SandboxResourceSchema)), assignedSandboxId: Type.Optional(ResourceIdSchema), enabled: Type.Boolean(), sessions: Type.Array(Type.Object({ lease: LeaseSchema, resourceId: Type.Optional(ResourceIdSchema), state: Type.String(), jobId: Type.Union([IdSchema, Type.Null()]) })) }, strict),
      execute: (args, api, c) => boundary(api, c, "view", async () => {
        const { owner: _, ...scope } = await catalog();
        const matches = readCatalog(await deps.fleet().catalogJson(args.requirements));
        return { ...scope, sandboxes: matches.filter(row => scope.sandboxes.some(provider => provider.id === row.id)), enabled: await deps.fleet().enabled(), sessions: await deps.fleet().sessions(deps.workspace()) };
      }) }),
    defineTool({ name: "sandbox_acquire", replay: "safe", description: "使用 resources 中的远程资源 id 作为 sandboxId，并提供其 providerId 对应的 capabilityRevision。相同资源复用同一个运行租约，各 agent 单独加入或退出；不同资源受设备并发容量限制。返回 id 用于 sandbox_call.leaseId。不会更改 bash/read/write/edit 的默认目标。",
      parameters: Type.Object({ sandboxId: deps.resources ? ResourceIdSchema : Type.String({ pattern: "^remote:[a-f0-9-]{36}$" }), capabilityRevision: Type.String({ pattern: "^[a-f0-9]{64}$" }), requirements: Type.Optional(RequirementsSchema) }, strict),
      structuredOutputSchema: Type.Object({ ...LeaseSchema.properties, resourceId: Type.Optional(ResourceIdSchema) }, strict),
      execute: (args, api, c) => boundary(api, c, "execute", async () => {
        const scope = await deps.resources?.();
        if (scope) {
          if (!scope.resources.some(resource => resource.id === args.sandboxId)) throw new Error("sandbox_not_assigned");
          const lease = await deps.fleet().acquireResource(scope.owner, deps.workspace(), "task:" + await hash(String(api.taskId)), { ...args, requirements: args.requirements ?? {} });
          return { ...lease, resourceId: args.sandboxId };
        }
        return deps.fleet().acquire({ ...args, requirements: args.requirements ?? {}, workspace: deps.workspace(),
          operationId: "task:" + await hash(String(api.taskId)) });
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
    defineTool({ name: "sandbox_release", replay: "safe", description: "退出指定远程租约；只释放自己的引用。其他 agent 仍持有时保留运行实例，最后一位退出才停止实例。资源 ID 保留，文件保留范围按提供方 persistence；本 agent 有运行或未知任务时先确认取消。",
      parameters: Type.Object({ leaseId: IdSchema }, strict), structuredOutputSchema: Type.Object({ leaseId: IdSchema, release: Type.Literal("requested") }, strict),
      execute: ({ leaseId }, api, c) => boundary(api, c, "control", async () => { await deps.fleet().release(deps.workspace(), leaseId); return { leaseId, release: "requested" }; }) }),
  ];
  return defineExtension({ name: "cs.sandbox", tools: tools.map(tool => ({ ...tool, callers: ["tools"] as const })),
    sections: [section("remote-sandbox", async (input, context) => {
      if (!input.agent.callable.some(tool => tool.name === "sandbox_list") || !await deps.allowed({ ...input.read, conversationId: input.conversationId }, context, "view")) return;
      const scope = await catalog(), providers = scope.sandboxes;
      const summary = { assignedSandboxId: scope.assignedSandboxId, resourceCount: scope.resources?.length, resources: scope.resources?.slice(0, 8), enabled: await deps.fleet().enabled(), total: providers.length, targets: providers.slice(0, 8).map(({ id, name, os, tools, codeModeTools, workspaceRoot, resourceLifecycle, instructions, persistence, availability }) =>
        ({ id, name, os, tools: tools.map(tool => tool.name), codeModeTools, workspaceRoot, resourceLifecycle, instructions, persistence, availability })), sessions: await deps.fleet().sessions(deps.workspace()) };
      return "沙箱目录与提供方使用说明：" + JSON.stringify(summary) +
        "。enabled=false 时仍可查看及取消、释放本工作区已有任务，只禁止新租约和新命令。所有沙箱能力只通过 Code Mode 调用。按任务需求查看 sandbox_list 中的完整配置、instructions 与工具 schema，再选择可用沙箱；远程 tools 通过 sandbox_acquire 获取显式租约后由 sandbox_call 调用，codeModeTools 可直接用 tools.<名称> 调用。" +
        (deps.createResource ? "提供方 ID 仅用于 sandbox_create；resources[].id 才是分配给 subagent 的 sandboxId，相同 ID 共享文件与实例。未指定 sandboxId 的新子 agent 默认继承父会话默认资源，需要独立工作区时先 sandbox_create，再把返回 ID 分配给一个或多个子 agent。Cloudflare 的 read/write/edit/bash 可用 sandboxId 显式选择资源。" : "你只能使用 assignedSandboxId 指定的资源，Cloudflare 文件工具固定指向该资源，不接受改绑。") +
        "共享写入需要 agent 协调文件范围，系统不自动合并。提供方使用说明只适用于对应沙箱，不改变宿主权限。不要假定不同沙箱共享路径、状态或文件，按各自注册说明使用；获取租约不会改变其他工具的执行目标。";
    }, { tag: false })] });
}

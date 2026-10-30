import { Type } from "typebox";
import { Check } from "typebox/value";
import { boundedJson } from "./schema";
import { mcpFailure } from "./result";
import { defineExtension, defineTool, section, type Registry, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { createInlineCodemodeSandbox } from "@earendil-works/pi-codemode/cloudflare";
import { compileMcpSchema } from "./schema";
import { MCP_CONFIG } from "./config";
import { slug, toolNames } from "./names";
import { snapshotCatalogs, type McpAuthority } from "./access";
import type { SubagentCapabilities } from "../subagent/model";

export type SubagentCodingOperation =
  | { kind: "exec"; operationId: string; command: string; timeoutMs: number }
  | { kind: "read"; operationId: string; path: string; offset?: number; limit?: number }
  | { kind: "write"; operationId: string; path: string; content: string }
  | { kind: "edit"; operationId: string; path: string; edits: { oldText: string; newText: string }[] };
export interface SubagentCapabilityHost {
  /** 每个实际操作的父端入口必须重核 scope/generation/当前授权；下面的检查供状态与读网页使用。 */
  validateSubagentAccess(id: string): Promise<{ authority: McpAuthority; capabilities: SubagentCapabilities } | undefined>;
  subagentMcp(id: string, call: { name: string; args: unknown; operationId: string }): Promise<ToolExecutionResult>;
  subagentSkill(id: string, input: { name: string; path?: string }): Promise<ToolExecutionResult>;
  subagentCoding(id: string, operation: SubagentCodingOperation): Promise<ToolExecutionResult>;
}

/** 主子 agent 共用 MCP 目录 schema、名字和父端运行时；子 DO 不持凭据或另建远端连接。 */
export function installDelegatedCapabilities(registry: Registry, host: SubagentCapabilityHost, id: string, capabilities: SubagentCapabilities) {
  const snapshot = capabilities.mcp, catalogs = snapshot ? snapshotCatalogs(snapshot) : [], sandbox = createInlineCodemodeSandbox();
  registry.install(defineExtension({ name: "cs.subagent.skills", tools: [
    defineTool({ name: "read_skill", description: "读取父线程当前已启用技能或附件；不授予发布技能权限。",
      parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 64 }), path: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) }, { additionalProperties: false }),
      replay: "safe", execute: args => host.subagentSkill(id, args) }),
  ] }));
  if (capabilities.coding) registry.install(defineExtension({ name: "cs.subagent.coding", tools: [
    defineTool({ name: "bash", description: "在派出时克隆的独立工作区执行命令，最长60秒；不能修改父工作区。",
      parameters: Type.Object({ command: Type.String({ minLength: 1 }), timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 60 })) }, { additionalProperties: false }),
      replay: "unsafe", execute: (args, api) => host.subagentCoding(id, { kind: "exec", operationId: String(api.taskId), command: args.command, timeoutMs: (args.timeout ?? 60) * 1000 }) }),
    defineTool({ name: "read", description: "读取子 agent 独立工作区文本。",
      parameters: Type.Object({ path: Type.String({ minLength: 1 }), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1 })) }, { additionalProperties: false }),
      replay: "safe", execute: (args, api) => host.subagentCoding(id, { kind: "read", operationId: String(api.taskId), ...args }) }),
    defineTool({ name: "write", description: "写入子 agent 独立工作区文本。",
      parameters: Type.Object({ path: Type.String({ minLength: 1 }), content: Type.String() }, { additionalProperties: false }),
      replay: "unsafe", execute: (args, api) => host.subagentCoding(id, { kind: "write", operationId: String(api.taskId), ...args }) }),
    defineTool({ name: "edit", description: "在子 agent 独立工作区执行精确文本替换。",
      parameters: Type.Object({ path: Type.String({ minLength: 1 }), edits: Type.Array(Type.Object({ oldText: Type.String({ minLength: 1 }), newText: Type.String() }, { additionalProperties: false }), { minItems: 1 }) }, { additionalProperties: false }),
      replay: "unsafe", execute: (args, api) => host.subagentCoding(id, { kind: "edit", operationId: String(api.taskId), ...args }) }),
  ] }));
  if (catalogs.length) {
    const codemode = createCodemodeExtension({ sandbox, models: false, namespaces: catalogs.map(c => ({ name: c.serverId, prefix: `mcp_${slug(c.serverId, 16)}_` })) });
    registry.install(defineExtension({ ...codemode, name: "cs.subagent.mcp",
      sections: [...codemode.sections ?? [], section("mcp-delegation", () => "MCP 只能使用派出目录与父线程当前授权的交集；写调用可能等待逐次审批。网页来源保持网页，不得另行通知 QQ。")] }));
    for (const catalog of catalogs) registry.install(defineExtension({ name: `cs.subagent.mcp.${catalog.serverId}`, tools: catalog.tools.map(tool => {
      const name = toolNames(catalog, tool).nativeName, input = compileMcpSchema(tool.inputSchema, MCP_CONFIG.limits);
      return defineTool({ name, description: tool.description, parameters: input.schema, replay: "unsafe", callers: ["tools"],
        execute: (args, api) => host.subagentMcp(id, { name, args, operationId: String(api.taskId) }) });
    }) }));
    registry.install(defineExtension({ name: "cs.subagent.mcp.resources", tools: (["list", "templates", "read"] as const).map(action => defineTool({
      name: `mcp_resources_${action}`, description: "读取已授权 MCP 服务的资源或目录。",
      parameters: Type.Object({ server: Type.String({ minLength: 1, maxLength: 64 }), uri: Type.Optional(Type.String({ maxLength: 4096 })) }, { additionalProperties: false }),
      replay: "safe", callers: ["tools"], execute: (args, api) => host.subagentMcp(id, { name: `mcp_resources_${action}`, args, operationId: String(api.taskId) }),
    })) }));
  }
  return { close: () => sandbox.close() };
}

/** 固定方法名的 RPC 适配器；返回值在边界解析，不把原始 RPC stub 或凭据交给模型。 */
export function createSubagentCapabilityHost(stub: object): SubagentCapabilityHost {
  const invoke = async (name: string, args: unknown[]) => {
    const method: unknown = Reflect.get(stub, name);
    if (typeof method !== "function") throw new Error("delegation_unavailable");
    const value: unknown = await Reflect.apply(method, stub, args);
    return boundedJson(value, MCP_CONFIG.limits.messageBytes, 32);
  };
  const output = Type.Object({ isError: Type.Optional(Type.Boolean()), output: Type.Optional(Type.Array(Type.Union([
    Type.Object({ type: Type.Literal("text"), text: Type.String() }),
    Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() }),
  ]))) });
  const result = async (method: string, args: unknown[]): Promise<ToolExecutionResult> => {
    try {
      const value = await invoke(method, args);
      return Check(output, value) ? { ...(value.isError ? { isError: true } : {}), output: value.output } : mcpFailure("result_rejected");
    } catch { return mcpFailure("denied"); }
  };
  return {
    async validateSubagentAccess(id) {
      const value = await invoke("validateSubagentAccess", [id]);
      if (value === null || value === undefined) return;
      const snapshot = Type.Object({ scope: Type.String(), actor: Type.String(), generation: Type.Integer({ minimum: 0 }),
        replyChannel: Type.Union([Type.Literal("web"), Type.Literal("qq")]), catalogJson: Type.String(), tools: Type.Array(Type.String()),
        resourceAllow: Type.Optional(Type.Array(Type.Object({ server: Type.String(), prefixes: Type.Array(Type.String()) }))) });
      const schema = Type.Object({
        authority: Type.Object({ kind: Type.Union(["message", "schedule", "event", "subagent"].map(v => Type.Literal(v))),
          scope: Type.String(), actor: Type.String(), owner: Type.Boolean(), generation: Type.Integer({ minimum: 0 }),
          replyChannel: Type.Union([Type.Literal("web"), Type.Literal("qq")]), subagentId: Type.Optional(Type.String()) }),
        capabilities: Type.Object({ coding: Type.Optional(Type.Boolean()), mcp: Type.Optional(snapshot) }),
      });
      if (!Check(schema, value)) throw new Error("delegation_denied");
      return value;
    },
    subagentMcp: (id, call) => result("subagentMcp", [id, call]),
    subagentSkill: (id, input) => result("subagentSkill", [id, input]),
    subagentCoding: (id, operation) => result("subagentCoding", [id, operation]),
  };
}

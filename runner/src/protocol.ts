import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";

const strict = { additionalProperties: false };
export const PROTOCOL_VERSION = 2;
export const MAX_CONTROL_BYTES = 256 * 1024;
export const LOG_MAX_BYTES = 1024 * 1024;
export const IdSchema = Type.String({ pattern: "^[a-zA-Z0-9:_-]{1,160}$" });
export const HashSchema = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const ToolNameSchema = Type.String({ pattern: "^[a-z][a-z0-9_]{0,63}$" });
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
// Cyclic 的 Static 在递归深处退化为 any；保留真实递归校验 schema，只修正其静态递归类型。
export const JsonValueSchema = Type.Unsafe<JsonValue>(Type.Cyclic({ Json: Type.Union([Type.Null(), Type.Boolean(), Type.Number(), Type.String(), Type.Array(Type.Ref("Json")), Type.Record(Type.String(), Type.Ref("Json"))]) }, "Json"));
export const JsonObjectSchema = Type.Record(Type.String(), JsonValueSchema);
export const ToolDeclarationSchema = Type.Object({ name: ToolNameSchema, description: Type.String({ minLength: 1, maxLength: 2000 }), inputSchema: JsonObjectSchema }, strict);
export type ToolDeclaration = Static<typeof ToolDeclarationSchema>;
export const SandboxInstructionsSchema = Type.String({ minLength: 1, maxLength: 4000 });
export const SandboxPersistenceSchema = Type.String({ minLength: 1, maxLength: 1000 });
export const DescriptorSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 80 }), provider: Type.String({ pattern: "^[a-z][a-z0-9-]{0,39}$" }),
  os: Type.String({ pattern: "^[a-z][a-z0-9-]{0,39}$" }), arch: Type.String({ pattern: "^[a-z0-9_-]{1,40}$" }),
  workspaceRoot: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  instructions: SandboxInstructionsSchema, persistence: SandboxPersistenceSchema,
  tools: Type.Array(ToolDeclarationSchema, { minItems: 1, maxItems: 16 }),
  environment: Type.Optional(Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 80 }), version: Type.String({ minLength: 1, maxLength: 120 }) }, strict), { maxItems: 64 })),
  memoryMiB: Type.Integer({ minimum: 1, maximum: 1048576 }), maxConcurrent: Type.Literal(1),
  maxTimeoutMs: Type.Integer({ minimum: 1000, maximum: 1200000 }), workspaceProtocol: Type.Literal("registered-tools-v2"),
}, strict);
export type Descriptor = Static<typeof DescriptorSchema>;
export const RequirementsSchema = Type.Object({
  os: Type.Optional(Type.String({ pattern: "^[a-z][a-z0-9-]{0,39}$" })), memoryMiB: Type.Optional(Type.Integer({ minimum: 1, maximum: 1048576 })),
  tools: Type.Optional(Type.Array(ToolNameSchema, { maxItems: 16, uniqueItems: true })),
}, strict);
export type Requirements = Static<typeof RequirementsSchema>;
export const PowerShellInputSchema = Type.Object({ command: Type.String({ minLength: 1, maxLength: 32000 }), cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })) }, strict);
export const ExecResultSchema = Type.Object({
  stdout: Type.String({ maxLength: 65536 }), stderr: Type.String({ maxLength: 65536 }),
  code: Type.Union([Type.Integer(), Type.Null()]), timedOut: Type.Boolean(), truncated: Type.Boolean(),
}, strict);
export type ExecResult = Static<typeof ExecResultSchema>;
const sessionLost = Type.Optional(Type.Boolean());
export const OutcomeSchema = Type.Union([
  Type.Object({ kind: Type.Literal("completed"), result: JsonValueSchema, sessionLost }, strict),
  Type.Object({ kind: Type.Literal("cancelled"), reason: Type.String({ minLength: 1, maxLength: 200 }), sessionLost }, strict),
  Type.Object({ kind: Type.Literal("failed"), error: Type.String({ minLength: 1, maxLength: 200 }), sessionLost }, strict),
  Type.Object({ kind: Type.Literal("unknown"), reason: Type.String({ minLength: 1, maxLength: 200 }), sessionLost }, strict),
]);
export type Outcome = Static<typeof OutcomeSchema>;
export const LeaseSchema = Type.Object({
  id: IdSchema, deviceId: IdSchema, sandboxId: IdSchema, workspace: IdSchema, operationId: IdSchema,
  capabilityRevision: HashSchema, requirements: RequirementsSchema, createdAt: Type.Number(),
}, strict);
export type Lease = Static<typeof LeaseSchema>;
export const JobInputSchema = Type.Object({
  id: IdSchema, lease: LeaseSchema, tool: ToolNameSchema, arguments: JsonObjectSchema,
  timeoutMs: Type.Integer({ minimum: 1000, maximum: 1200000 }), createdAt: Type.Number(), deadline: Type.Number(),
}, strict);
export type JobInput = Static<typeof JobInputSchema>;
export const DeviceFrameSchema = Type.Union([
  Type.Object({ kind: Type.Literal("hello"), protocolVersion: Type.Literal(PROTOCOL_VERSION), descriptor: DescriptorSchema }, strict),
  Type.Object({ kind: Type.Literal("accepted"), jobId: IdSchema }, strict),
  Type.Object({ kind: Type.Literal("progress"), jobId: IdSchema, sequence: Type.Integer({ minimum: 0 }), text: Type.String({ maxLength: 16384 }) }, strict),
  Type.Object({ kind: Type.Literal("outcome"), jobId: IdSchema, outcome: OutcomeSchema }, strict),
  Type.Object({ kind: Type.Literal("released"), leaseId: IdSchema }, strict),
]);
export type DeviceFrame = Static<typeof DeviceFrameSchema>;
export const ServerFrameSchema = Type.Union([
  Type.Object({ kind: Type.Literal("welcome"), capabilityRevision: HashSchema, deviceId: IdSchema }, strict),
  Type.Object({ kind: Type.Literal("execute"), jobId: IdSchema }, strict),
  Type.Object({ kind: Type.Literal("cancel"), jobId: IdSchema }, strict),
  Type.Object({ kind: Type.Literal("release"), leaseId: IdSchema }, strict),
  Type.Object({ kind: Type.Literal("outcome_ack"), jobId: IdSchema }, strict),
  Type.Object({ kind: Type.Literal("error"), error: Type.String({ maxLength: 200 }) }, strict),
]);
export type ServerFrame = Static<typeof ServerFrameSchema>;
export function parse<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Check(schema, value)) throw new Error("invalid_request");
  return value;
}
export function parseFrame<T extends TSchema>(schema: T, raw: string): Static<T> {
  if (new TextEncoder().encode(raw).length > MAX_CONTROL_BYTES) throw new Error("frame_too_large");
  return parse(schema, JSON.parse(raw));
}
function jsonSize(value: unknown, limit: number): void {
  function visit(item: unknown, depth: number): void {
    if (depth > 12) throw new Error("json_too_deep");
    if (item === null || typeof item === "string" || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) return;
    if (Array.isArray(item)) { for (const child of item) visit(child, depth + 1); return; }
    if (typeof item !== "object" || Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error("invalid_json");
    for (const child of Object.values(item)) visit(child, depth + 1);
  }
  visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(value)).length > limit) throw new Error("json_too_large");
}
/** 注册目录只接受有界的基础 JSON Schema；禁止引用、正则和可执行扩展。 */
export function validateDescriptor(value: unknown): Descriptor {
  const descriptor = parse(DescriptorSchema, value); jsonSize(descriptor, 64 * 1024);
  const names = new Set<string>();
  function schema(input: unknown, depth: number): void {
    if (depth > 6) throw new Error("schema_too_deep");
    const node = parse(JsonObjectSchema, input);
    if (typeof node.type !== "string" || !["object", "array", "string", "number", "integer", "boolean", "null"].includes(node.type)) throw new Error("invalid_tool_schema");
    const allowed = new Set(["type", "description", "enum", ...(node.type === "object" ? ["properties", "required", "additionalProperties"] : node.type === "array" ? ["items", "minItems", "maxItems"] : node.type === "string" ? ["minLength", "maxLength"] : node.type === "number" || node.type === "integer" ? ["minimum", "maximum"] : [])]);
    if (Object.keys(node).some(key => !allowed.has(key))) throw new Error("unsupported_tool_schema");
    if (node.description !== undefined && (typeof node.description !== "string" || node.description.length > 2000)) throw new Error("invalid_tool_schema");
    if (node.enum !== undefined && (!Array.isArray(node.enum) || !node.enum.length || node.enum.length > 64 || node.enum.some(x => x !== null && !["string", "number", "boolean"].includes(typeof x)))) throw new Error("invalid_tool_schema");
    for (const key of ["minItems", "maxItems", "minLength", "maxLength"]) if (node[key] !== undefined && (typeof node[key] !== "number" || !Number.isSafeInteger(node[key]) || node[key] < 0 || node[key] > 65536)) throw new Error("invalid_tool_schema");
    for (const key of ["minimum", "maximum"]) if (node[key] !== undefined && (typeof node[key] !== "number" || !Number.isFinite(node[key]))) throw new Error("invalid_tool_schema");
    if (node.type === "object") {
      const properties = parse(JsonObjectSchema, node.properties ?? {});
      if (Object.keys(properties).length > 64 || node.additionalProperties !== false) throw new Error("invalid_tool_schema");
      if (node.required !== undefined && (!Array.isArray(node.required) || node.required.some(key => typeof key !== "string" || !Object.hasOwn(properties, key)) || new Set(node.required).size !== node.required.length)) throw new Error("invalid_tool_schema");
      for (const child of Object.values(properties)) schema(child, depth + 1);
    }
    if (node.type === "array") schema(node.items, depth + 1);
  }
  for (const tool of descriptor.tools) {
    if (names.has(tool.name)) throw new Error("duplicate_tool"); names.add(tool.name);
    schema(tool.inputSchema, 0);
    if (tool.inputSchema.type !== "object") throw new Error("tool_arguments_must_be_object");
  }
  return descriptor;
}
export function validateToolArguments(descriptor: Descriptor, name: string, value: unknown): Record<string, JsonValue> {
  const tool = descriptor.tools.find(item => item.name === name); if (!tool) throw new Error("tool_not_registered");
  jsonSize(value, 64 * 1024);
  const args = parse(JsonObjectSchema, value);
  if (!Check(tool.inputSchema, args)) throw new Error("invalid_tool_arguments");
  return args;
}
export function validateOutcome(value: unknown): Outcome { jsonSize(value, MAX_CONTROL_BYTES); return parse(OutcomeSchema, value); }
export function mismatch(descriptor: Descriptor, requirements: Requirements): string[] {
  const reasons: string[] = [];
  if (requirements.os && descriptor.os !== requirements.os) reasons.push("os");
  if (requirements.memoryMiB && descriptor.memoryMiB < requirements.memoryMiB) reasons.push("memory");
  for (const tool of requirements.tools ?? []) if (!descriptor.tools.some(item => item.name === tool)) reasons.push("tool:" + tool);
  return reasons;
}

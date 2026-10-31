import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";

const strict = { additionalProperties: false };
export const PROTOCOL_VERSION = 1;
export const MAX_CONTROL_BYTES = 128 * 1024;
export const FILE_MAX_BYTES = 10 * 1024 * 1024;
export const SOURCE_MAX_BYTES = 50 * 1024 * 1024;
export const LOG_MAX_BYTES = 1024 * 1024;
export const IdSchema = Type.String({ pattern: "^[a-zA-Z0-9:_-]{1,160}$" });
export const HashSchema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const Version = Type.String({ minLength: 1, maxLength: 120 });
const Path = Type.String({ minLength: 1, maxLength: 1024 });
export const TaskTypeSchema = Type.Union([Type.Literal("shell.exec"), Type.Literal("node.test")]);
export const ShellSchema = Type.Union([Type.Literal("powershell"), Type.Literal("bash")]);
export const DescriptorSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  provider: Type.Literal("windows-wsb"),
  os: Type.Literal("windows"),
  arch: Type.Union([Type.Literal("x64"), Type.Literal("arm64")]),
  shells: Type.Array(ShellSchema, { minItems: 1, maxItems: 2, uniqueItems: true }),
  tools: Type.Array(Type.Object({ name: Type.String({ pattern: "^[a-z0-9-]{1,40}$" }), version: Version }, strict), { maxItems: 32 }),
  taskTypes: Type.Array(TaskTypeSchema, { minItems: 1, maxItems: 2, uniqueItems: true }),
  memoryMiB: Type.Integer({ minimum: 2048, maximum: 65536 }),
  maxConcurrent: Type.Literal(1),
  maxTimeoutMs: Type.Integer({ minimum: 1000, maximum: 1200000 }),
  workspaceProtocol: Type.Literal("r2-source-v1"),
  cache: Type.Object({ npm: Type.Boolean(), git: Type.Boolean() }, strict),
}, strict);
export type Descriptor = Static<typeof DescriptorSchema>;
export const RequirementsSchema = Type.Object({
  os: Type.Optional(Type.Union([Type.Literal("windows"), Type.Literal("linux")])),
  shell: Type.Optional(ShellSchema),
  memoryMiB: Type.Optional(Type.Integer({ minimum: 1, maximum: 65536 })),
  tools: Type.Optional(Type.Array(Type.Object({ name: Type.String({ pattern: "^[a-z0-9-]{1,40}$" }), version: Type.Optional(Version) }, strict), { maxItems: 16 })),
}, strict);
export type Requirements = Static<typeof RequirementsSchema>;
export const OperationSchema = Type.Union([
  Type.Object({ kind: Type.Literal("shell.exec"), command: Type.String({ minLength: 1, maxLength: 32000 }), shell: ShellSchema, cwd: Path, timeoutMs: Type.Integer({ minimum: 1000, maximum: 1200000 }) }, strict),
  Type.Object({ kind: Type.Literal("node.test"), script: Type.String({ pattern: "^[a-zA-Z0-9:_-]{1,80}$" }), cwd: Path, timeoutMs: Type.Integer({ minimum: 1000, maximum: 1200000 }) }, strict),
]);
export type Operation = Static<typeof OperationSchema>;
export const FileSchema = Type.Object({ path: Path, sha256: HashSchema, bytes: Type.Integer({ minimum: 0, maximum: FILE_MAX_BYTES }), mime: Type.String({ minLength: 1, maxLength: 200 }), mode: Type.Integer({ minimum: 0, maximum: 511 }) }, strict);
export const SnapshotSchema = Type.Object({
  files: Type.Array(FileSchema, { maxItems: 20000 }), directories: Type.Array(Path, { maxItems: 20000 }),
  totalBytes: Type.Integer({ minimum: 0, maximum: SOURCE_MAX_BYTES }),
}, strict);
export type Snapshot = Static<typeof SnapshotSchema>;
export const ExecResultSchema = Type.Object({
  stdout: Type.String({ maxLength: 65536 }), stderr: Type.String({ maxLength: 65536 }),
  code: Type.Union([Type.Integer(), Type.Null()]), timedOut: Type.Boolean(), truncated: Type.Boolean(),
}, strict);
export type ExecResult = Static<typeof ExecResultSchema>;
export const OutcomeSchema = Type.Union([
  Type.Object({ kind: Type.Literal("completed"), result: ExecResultSchema, snapshot: SnapshotSchema }, strict),
  Type.Object({ kind: Type.Literal("cancelled"), reason: Type.String({ maxLength: 200 }) }, strict),
  Type.Object({ kind: Type.Literal("failed"), error: Type.String({ minLength: 1, maxLength: 200 }) }, strict),
  Type.Object({ kind: Type.Literal("unknown"), reason: Type.String({ minLength: 1, maxLength: 200 }) }, strict),
]);
export type Outcome = Static<typeof OutcomeSchema>;
export const LeaseSchema = Type.Object({
  id: IdSchema, deviceId: IdSchema, sandboxId: IdSchema, workspace: IdSchema, operationId: IdSchema,
  capabilityRevision: HashSchema, taskType: TaskTypeSchema, requirements: RequirementsSchema, createdAt: Type.Number(),
}, strict);
export type Lease = Static<typeof LeaseSchema>;
export const JobInputSchema = Type.Object({
  id: IdSchema, lease: LeaseSchema, operation: OperationSchema, baseRevision: Type.String({ minLength: 1, maxLength: 64 }),
  source: SnapshotSchema, createdAt: Type.Number(), deadline: Type.Number(),
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
export function relativePath(raw: string, directory = false): string {
  const path = raw === "/work" ? "" : raw.startsWith("/work/") ? raw.slice(6) : raw;
  if (directory && (path === "" || path === ".")) return "";
  if (!path || path.length > 1024 || /[\\:*?"<>|\x00-\x1f]/.test(path) || path.startsWith("/") ||
    path.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) throw new Error("path_denied");
  return path;
}
export function ephemeralPath(path: string): boolean {
  return path.split("/").some(part => [".git", "node_modules", ".wrangler"].includes(part.toLowerCase()));
}
export function validateSnapshot(input: unknown): Snapshot {
  const snapshot = parse(SnapshotSchema, input);
  if (new TextEncoder().encode(JSON.stringify(snapshot)).length > 6 * 1024 * 1024) throw new Error("manifest_too_large");
  const files = new Set<string>(), names = new Set<string>();
  let bytes = 0;
  for (const row of snapshot.files) {
    const path = relativePath(row.path), key = path.toLowerCase();
    if (ephemeralPath(path) || names.has(key)) throw new Error("path_denied");
    names.add(key); files.add(key); bytes += row.bytes;
  }
  for (const raw of snapshot.directories) {
    const path = relativePath(raw), key = path.toLowerCase();
    if (ephemeralPath(path) || names.has(key)) throw new Error("path_denied");
    names.add(key);
  }
  for (const name of names) {
    const parts = name.split("/");
    for (let n = 1; n < parts.length; n++) if (files.has(parts.slice(0, n).join("/"))) throw new Error("path_denied");
  }
  if (bytes !== snapshot.totalBytes) throw new Error("workspace_quota");
  return snapshot;
}
export function mismatch(descriptor: Descriptor, taskType: string, requirements: Requirements): string[] {
  const reasons: string[] = [];
  if (!descriptor.taskTypes.some(type => type === taskType)) reasons.push("task_type");
  if (requirements.os && descriptor.os !== requirements.os) reasons.push("os");
  if (requirements.shell && !descriptor.shells.includes(requirements.shell)) reasons.push("shell");
  if (requirements.memoryMiB && descriptor.memoryMiB < requirements.memoryMiB) reasons.push("memory");
  for (const tool of requirements.tools ?? []) if (!descriptor.tools.some(item => item.name === tool.name && (!tool.version || item.version === tool.version))) reasons.push("tool:" + tool.name);
  return reasons;
}

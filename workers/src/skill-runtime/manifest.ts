import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { DEFAULT_MCP_LIMITS } from "../mcp/config";
import { boundedJson, compileMcpSchema } from "../mcp/schema";

export const SKILL_RUNNER_FILE = "runner.json";
export const DEFAULT_AUTH_EXIT_CODE = 41;
export const SKILL_MAX_OUTPUT_FILES = 5;
export const SKILL_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const SKILL_STATE_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const SKILL_STATE_MAX_BYTES = 50 * 1024 * 1024;

export const SkillNameSchema = Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" });
export const SkillActionNameSchema = Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" });
export const SkillGroupSchema = Type.String({ pattern: "^group:[1-9][0-9]{0,19}$" });

const ACTION_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const strict = { additionalProperties: false } as const;

export const SkillRunnerActionSchema = Type.Object({
  command: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { minItems: 1, maxItems: 32 }),
  description: Type.String({ minLength: 1, maxLength: 300 }),
  ownerOnly: Type.Optional(Type.Boolean()),
  timeoutSec: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })),
  argsSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, strict);

export const SkillRunnerSchema = Type.Object({
  version: Type.Literal(1),
  authExitCode: Type.Optional(Type.Integer({ minimum: 1, maximum: 255 })),
  deps: Type.Optional(Type.Object({ kind: Type.Literal("npm") }, strict)),
  actions: Type.Record(SkillActionNameSchema, SkillRunnerActionSchema, { minProperties: 1, maxProperties: 32 }),
}, strict);

export type SkillRunnerAction = Static<typeof SkillRunnerActionSchema>;
export type SkillRunnerManifest = Static<typeof SkillRunnerSchema>;

const BUILTIN_EXECUTABLES = new Set(["python3", "node"]);

/** 将 Skill 内相对可执行路径规范化并拒绝目录穿越。 */
export function resolveSkillRelativePath(raw: string): string | undefined {
  if (!raw || raw.includes("\0") || raw.includes("\\") || raw.startsWith("/")) return undefined;
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") return undefined;
    parts.push(part);
  }
  return parts.length ? parts.join("/") : undefined;
}

function invalidRunner(): never {
  throw new Error("invalid_runner");
}

/** 解析并校验 Skill 附件中的 runner.json；未提供时返回 undefined。 */
export function parseSkillRunner(files: Record<string, string>): SkillRunnerManifest | undefined {
  if (!Object.hasOwn(files, SKILL_RUNNER_FILE)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(files[SKILL_RUNNER_FILE]!);
  } catch {
    invalidRunner();
  }
  if (!Check(SkillRunnerSchema, parsed)) invalidRunner();
  const entries = Object.entries(parsed.actions);
  if (entries.length < 1 || entries.length > 32) invalidRunner();
  for (const [name, action] of entries) {
    if (!ACTION_NAME_RE.test(name)) invalidRunner();
    if (action.command.some(part => part.includes("\0"))) invalidRunner();
    const head = action.command[0]!;
    if (!BUILTIN_EXECUTABLES.has(head)) {
      const relative = resolveSkillRelativePath(head);
      if (!relative || relative === SKILL_RUNNER_FILE || !Object.hasOwn(files, relative)) invalidRunner();
    }
    if (action.argsSchema !== undefined) {
      try {
        compileMcpSchema(action.argsSchema, DEFAULT_MCP_LIMITS);
      } catch {
        invalidRunner();
      }
    }
  }
  if (parsed.deps?.kind === "npm") {
    if (!Object.hasOwn(files, "package.json") || !Object.hasOwn(files, "package-lock.json")) invalidRunner();
  }
  return parsed;
}

/** 校验动作调用参数：未声明 argsSchema 时只接受空对象或省略。 */
export function validateSkillActionArgs(action: SkillRunnerAction, rawArgs: unknown): Record<string, unknown> {
  if (action.argsSchema === undefined) {
    if (rawArgs === undefined) return {};
    if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs) || Object.keys(rawArgs).length > 0) {
      throw new Error("skill_invalid_args");
    }
    return {};
  }
  const candidate = rawArgs ?? {};
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new Error("skill_invalid_args");
  }
  let bounded: unknown;
  try {
    bounded = boundedJson(candidate, 64 * 1024, 16);
  } catch {
    throw new Error("skill_invalid_args");
  }
  const compiled = compileMcpSchema(action.argsSchema, DEFAULT_MCP_LIMITS);
  if (!compiled.check(bounded)) throw new Error("skill_invalid_args");
  return bounded as Record<string, unknown>;
}

/** 将 runner.json 的 command 转换为容器内执行的 argv（不经 shell）。 */
export function normalizeSkillScriptArgv(command: readonly string[], skillDir: string): string[] {
  if (!command.length) throw new Error("invalid_runner");
  const head = command[0]!;
  if (BUILTIN_EXECUTABLES.has(head)) return [...command];
  const relative = resolveSkillRelativePath(head);
  if (!relative) throw new Error("invalid_runner");
  const root = skillDir.replace(/\/+$/, "");
  return [`${root}/${relative}`, ...command.slice(1)];
}

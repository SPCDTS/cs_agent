import { copyJson } from "@earendil-works/chord/json";
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { Env } from "../env";
import { workPath } from "../sandbox/client";
import { temporaryFileRef } from "../sandbox/object-files";
import { relativeWorkPath } from "../sandbox/workspace";
import {
  normalizeSkillScriptArgv,
  SKILL_STATE_FILE_MAX_BYTES,
  SkillActionNameSchema,
  SkillGroupSchema,
  SkillNameSchema,
  type SkillRunnerAction,
  validateSkillActionArgs,
} from "./manifest";
import type { SkillRuntimeSnapshot } from "./grants";

export type SkillRuntimeCaller = { scope: string; origin: "qq" | "web" };
export type SkillRuntimeRegistry = Pick<
  ReturnType<Env["REGISTRY"]["getByName"]>,
  | "skillRuntimeList"
  | "skillRuntimeResolve"
  | "skillRuntimeResolveOwnerSkill"
  | "skillRuntimeGrant"
  | "skillRuntimeAuthAlert"
  | "skillRuntimeAuthResolved"
>;
export type SkillRuntimeSandbox = Pick<
  ReturnType<Env["SANDBOX"]["getByName"]>,
  | "skillRun"
  | "skillOwnerBash"
  | "skillStateList"
  | "skillStateImport"
  | "skillStateClear"
  | "readObject"
  | "readBlob"
  | "writeObject"
>;

export type SkillRuntimeHost = {
  namespace: string;
  caller(api: ToolExecutionApi, context: Context): Promise<SkillRuntimeCaller | undefined>;
  registry: SkillRuntimeRegistry;
  sandbox(name: string): SkillRuntimeSandbox;
  audit(op: string, detail: object): Promise<unknown>;
};

const strict = { additionalProperties: false } as const;
const resultSchema = Type.Record(Type.String(), Type.Unknown());
const SAFE_ERROR = /^(skill_[a-z_]+|invalid_runner|not_found|file_too_large|too_large|path_denied|invalid_request|sandbox_unavailable|output_limit|workspace_quota|blob_corrupt|unconfigured|oauth_token|delegation_denied)$/;

export function skillRuntimeErrorCode(error: unknown): string {
  const code = error instanceof Error ? error.message.split(":")[0] ?? "" : "";
  return SAFE_ERROR.test(code) ? code : "skill_failed";
}

export function jsonToolResult(value: unknown): ToolExecutionResult {
  const json = JSON.stringify(value);
  return { output: [{ type: "text", text: json }], structuredOutput: copyJson(JSON.parse(json)) };
}

export async function writeSkillOutputs(
  targetSandbox: Pick<SkillRuntimeSandbox, "writeObject">,
  skill: string,
  outputs: ReadonlyArray<{ path: string; bytes: number; data: Uint8Array }>,
): Promise<Array<{ path: string; originalPath: string; bytes: number }>> {
  if (!outputs.length) return [];
  const runId = crypto.randomUUID();
  const saved: Array<{ path: string; originalPath: string; bytes: number }> = [];
  for (const item of outputs) {
    const rel = relativeWorkPath(item.path);
    const ref = temporaryFileRef(`skill-outputs/${skill}/${runId}/${rel}`);
    await targetSandbox.writeObject(ref, item.data);
    saved.push({ path: ref, originalPath: rel, bytes: item.bytes });
  }
  return saved;
}

export function formatSkillRuntimeList<
  T extends { skill: string; description: string; actions: Array<{ name: string; description: string; timeoutSec: number; ownerOnly?: boolean; argsSchemaJson?: string }> },
>(items: readonly T[]) {
  return items.map(({ actions, ...rest }) => ({
    ...rest,
    actions: actions.map(({ argsSchemaJson, ...action }) => ({
      ...action,
      ...(argsSchemaJson ? { argsSchema: JSON.parse(argsSchemaJson) as Record<string, unknown> } : {}),
    })),
  }));
}

export async function executeResolvedSkillRun(deps: {
  scope: string;
  origin: "qq" | "web";
  skill: string;
  action: string;
  args: unknown;
  timeoutSec?: number;
  snapshot?: SkillRuntimeSnapshot;
  registry: Pick<SkillRuntimeRegistry, "skillRuntimeResolve" | "skillRuntimeAuthAlert" | "skillRuntimeAuthResolved">;
  stateSandbox: Pick<SkillRuntimeSandbox, "skillRun">;
  outputSandbox: Pick<SkillRuntimeSandbox, "writeObject">;
  recheckAccess(): Promise<void>;
}) {
  const resolved = await deps.registry.skillRuntimeResolve(deps.scope, deps.skill, deps.action, deps.snapshot);
  const actionSpec: SkillRunnerAction = {
    command: resolved.action.command,
    description: resolved.action.description,
    ownerOnly: resolved.action.ownerOnly,
    timeoutSec: resolved.action.timeoutSec,
    ...(resolved.action.argsSchemaJson ? { argsSchema: JSON.parse(resolved.action.argsSchemaJson) as Record<string, unknown> } : {}),
  };
  const validatedArgs = validateSkillActionArgs(actionSpec, deps.args);
  const argv = normalizeSkillScriptArgv(actionSpec.command, "/opt/skill");
  const timeoutMs = Math.min(actionSpec.timeoutSec ?? 30, deps.timeoutSec ?? 120) * 1000;
  const outcome = await deps.stateSandbox.skillRun({
    skill: deps.skill,
    revision: resolved.revision,
    files: resolved.files,
    installNpmDeps: resolved.installNpmDeps,
    depsHash: resolved.depsHash,
    argv,
    stdin: JSON.stringify(validatedArgs),
    timeoutMs,
  });
  await deps.recheckAccess();
  await deps.registry.skillRuntimeResolve(deps.scope, deps.skill, deps.action, deps.snapshot);
  const outputs = await writeSkillOutputs(deps.outputSandbox, deps.skill, outcome.outputs);
  const authRequired = !outcome.timedOut && outcome.code === resolved.authExitCode;
  if (authRequired) {
    await deps.registry.skillRuntimeAuthAlert(deps.skill, deps.origin, outcome.stateRevision || resolved.revision);
  } else if (deps.scope === "owner" && actionSpec.ownerOnly && !outcome.timedOut && outcome.code === 0) {
    await deps.registry.skillRuntimeAuthResolved(deps.skill);
  }
  return {
    ok: outcome.code === 0 && !outcome.timedOut,
    code: outcome.code,
    timedOut: outcome.timedOut,
    truncated: outcome.truncated,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    outputs,
    ...(authRequired ? { authRequired: true } : {}),
  };
}

export function skillRuntimeExtension(host: SkillRuntimeHost) {
  async function run(
    api: ToolExecutionApi,
    context: Context,
    op: string,
    skill: string,
    work: (caller: SkillRuntimeCaller) => Promise<unknown>,
    extraAudit?: object,
  ): Promise<ToolExecutionResult> {
    const started = Date.now();
    let outcome = "error";
    let scope = host.namespace;
    let code: number | null | undefined;
    try {
      const caller = await host.caller(api, context);
      if (!caller || caller.scope !== host.namespace || (op !== "actions" && op !== "run" && caller.scope !== "owner")) {
        throw new Error("skill_denied");
      }
      scope = caller.scope;
      const value = await work(caller);
      if (value && typeof value === "object" && "code" in value && (typeof value.code === "number" || value.code === null)) {
        code = value.code;
      }
      outcome = "ok";
      return jsonToolResult(value);
    } catch (error) {
      outcome = skillRuntimeErrorCode(error);
      return { isError: true, output: [{ type: "text", text: outcome }] };
    } finally {
      if (op !== "actions" && op !== "state_list") {
        await host.audit(op, { skill, scope, result: outcome, ...(code !== undefined ? { code } : {}), ...extraAudit, ms: Date.now() - started })
          .catch(() => console.warn("skill_runtime_audit_failed"));
      }
    }
  }

  const requireCallerScope = async (api: ToolExecutionApi, context: Context, expectedScope: string) => {
    const after = await host.caller(api, context);
    if (!after || after.scope !== expectedScope) throw new Error("skill_denied");
  };

  const ownerTools = host.namespace === "owner" ? [
    defineTool({
      name: "skill_owner_bash",
      description: "仅主人交互回合可用：在受控技能的专属加密状态沙箱（/opt/skill 只读代码、/work/state 持久登录态、/work/out 临时产物）中执行登录或调试命令并自动加密写回状态。",
      replay: "unsafe",
      structuredOutputSchema: resultSchema,
      parameters: Type.Object({
        skill: SkillNameSchema,
        command: Type.String({ minLength: 1, maxLength: 16384 }),
        timeoutSec: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })),
      }, strict),
      execute: ({ skill, command, timeoutSec }, api, context) => run(api, context, "owner_bash", skill, async caller => {
        const resolved = await host.registry.skillRuntimeResolveOwnerSkill(skill);
        const outcome = await host.sandbox("skill-state:" + skill).skillOwnerBash({
          skill,
          revision: resolved.revision,
          files: resolved.files,
          installNpmDeps: resolved.installNpmDeps,
          depsHash: resolved.depsHash,
          command,
          timeoutMs: (timeoutSec ?? 60) * 1000,
        });
        await requireCallerScope(api, context, caller.scope);
        const outputs = await writeSkillOutputs(host.sandbox("owner"), skill, outcome.outputs);
        if (!outcome.timedOut && outcome.code === 0) await host.registry.skillRuntimeAuthResolved(skill);
        return {
          ok: outcome.code === 0 && !outcome.timedOut,
          code: outcome.code,
          timedOut: outcome.timedOut,
          truncated: outcome.truncated,
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          outputs,
        };
      }),
    }),
    defineTool({
      name: "skill_state_import",
      description: "仅主人交互回合可用：从主人工作区（/work/...）或私有对象（r2://...）直接导入登录态文件到技能的加密状态目录，不经模型上下文传递内容。",
      replay: "unsafe",
      structuredOutputSchema: resultSchema,
      parameters: Type.Object({
        skill: SkillNameSchema,
        fromPath: Type.String({ minLength: 1, maxLength: 1024 }),
        toPath: Type.String({ minLength: 1, maxLength: 1024 }),
      }, strict),
      execute: ({ skill, fromPath, toPath }, api, context) => run(api, context, "state_import", skill, async caller => {
        await host.registry.skillRuntimeResolveOwnerSkill(skill);
        const ownerSandbox = host.sandbox("owner");
        const bytes = fromPath.startsWith("r2://")
          ? await ownerSandbox.readObject(fromPath)
          : (await ownerSandbox.readBlob(workPath(fromPath), undefined, SKILL_STATE_FILE_MAX_BYTES)).bytes;
        if (bytes.byteLength > SKILL_STATE_FILE_MAX_BYTES) throw new Error("too_large");
        await requireCallerScope(api, context, caller.scope);
        const summary = await host.sandbox("skill-state:" + skill).skillStateImport({
          skill,
          files: [{ path: relativeWorkPath(toPath), bytes }],
        });
        await host.registry.skillRuntimeAuthResolved(skill);
        return { skill: summary.skill, revision: summary.revision, fileCount: summary.fileCount, totalBytes: summary.totalBytes };
      }),
    }),
    defineTool({
      name: "skill_state_list",
      description: "仅主人交互回合可用：查看技能加密状态目录的文件路径与字节数（不返回文件内容）。",
      replay: "safe",
      structuredOutputSchema: resultSchema,
      parameters: Type.Object({ skill: SkillNameSchema }, strict),
      execute: ({ skill }, api, context) => run(api, context, "state_list", skill, async () => {
        await host.registry.skillRuntimeResolveOwnerSkill(skill);
        return host.sandbox("skill-state:" + skill).skillStateList(skill);
      }),
    }),
    defineTool({
      name: "skill_state_clear",
      description: "仅主人交互回合可用：清空指定技能的全部加密登录态文件。",
      replay: "unsafe",
      structuredOutputSchema: resultSchema,
      parameters: Type.Object({ skill: SkillNameSchema }, strict),
      execute: ({ skill }, api, context) => run(api, context, "state_clear", skill, async () => {
        await host.registry.skillRuntimeResolveOwnerSkill(skill);
        const res = await host.sandbox("skill-state:" + skill).skillStateClear(skill);
        await host.registry.skillRuntimeAuthResolved(skill);
        return { skill, ...res };
      }),
    }),
    defineTool({
      name: "skill_grant",
      description: "仅主人交互回合可用：授予或撤销（actions 传空数组）指定群对受控技能非 ownerOnly 动作的执行权限。",
      replay: "unsafe",
      structuredOutputSchema: resultSchema,
      parameters: Type.Object({
        skill: SkillNameSchema,
        group: SkillGroupSchema,
        actions: Type.Array(SkillActionNameSchema, { maxItems: 32 }),
      }, strict),
      execute: ({ skill, group, actions }, api, context) => run(api, context, "grant", skill,
        () => host.registry.skillRuntimeGrant(skill, group, actions), { group }),
    }),
  ] : [];

  return defineExtension({
    name: "cs.skill-runtime",
    namespace: { name: "skills", description: "受控 Skill 执行、群授权与加密登录态管理" },
    tools: [
      ...ownerTools,
      defineTool({
        name: "skill_actions",
        description: "列出当前会话已获授权的受控技能及可执行动作、参数要求与超时配置。",
        replay: "safe",
        structuredOutputSchema: resultSchema,
        parameters: Type.Object({}, strict),
        execute: (_args, api, context) => run(api, context, "actions", "", async caller => ({
          skills: formatSkillRuntimeList(await host.registry.skillRuntimeList(caller.scope)),
        })),
      }),
      defineTool({
        name: "skill_run",
        description: "在隔离的技能加密状态沙箱中运行已授权动作，自动写回更新后的登录态并将输出产物写入 r2://.tmp/...。",
        replay: "unsafe",
        structuredOutputSchema: resultSchema,
        parameters: Type.Object({
          skill: SkillNameSchema,
          action: SkillActionNameSchema,
          args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
          timeoutSec: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })),
        }, strict),
        execute: ({ skill, action, args, timeoutSec }, api, context) => run(api, context, "run", skill, caller =>
          executeResolvedSkillRun({
            scope: caller.scope,
            origin: caller.origin,
            skill,
            action,
            args,
            timeoutSec,
            registry: host.registry,
            stateSandbox: host.sandbox("skill-state:" + skill),
            outputSandbox: host.sandbox(caller.scope),
            recheckAccess: () => requireCallerScope(api, context, caller.scope),
          }), { action }),
      }),
    ].map(tool => ({ ...tool, callers: ["tools"] as const })),
  });
}

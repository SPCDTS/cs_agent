import { copyJson } from "@earendil-works/chord/json";
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { Env } from "../env";
import { workPath } from "../sandbox/client";
import { temporaryFileRef } from "../sandbox/object-files";
import { relativeWorkPath } from "../sandbox/workspace";
import {
  SKILL_STATE_FILE_MAX_BYTES,
  SkillGroupSchema,
  SkillNameSchema,
} from "./manifest";
import type { SkillRuntimeSnapshot } from "./grants";

export type SkillRuntimeCaller = { scope: string; origin: "qq" | "web" };
export type SkillRuntimeRegistry = Pick<
  ReturnType<Env["REGISTRY"]["getByName"]>,
  | "skillRuntimeList"
  | "skillRuntimeResolve"
  | "skillRuntimeGrant"
  | "skillRuntimeAuthResolved"
>;
export type SkillRuntimeSandbox = Pick<
  ReturnType<Env["SANDBOX"]["getByName"]>,
  | "skillBash"
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
const SAFE_ERROR = /^(skill_[a-z_]+|not_found|file_too_large|too_large|path_denied|invalid_request|sandbox_unavailable|output_limit|workspace_quota|blob_corrupt|unconfigured|oauth_token|delegation_denied)$/;

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

export async function executeResolvedSkillBash(deps: {
  scope: string;
  skill: string;
  command: string;
  timeoutSec?: number;
  snapshot?: SkillRuntimeSnapshot;
  registry: Pick<SkillRuntimeRegistry, "skillRuntimeResolve" | "skillRuntimeAuthResolved">;
  stateSandbox: Pick<SkillRuntimeSandbox, "skillBash">;
  outputSandbox: Pick<SkillRuntimeSandbox, "writeObject">;
  recheckAccess(): Promise<void>;
}) {
  const resolved = await deps.registry.skillRuntimeResolve(deps.scope, deps.skill, deps.snapshot);
  const timeoutMs = (deps.timeoutSec ?? 60) * 1000;
  const outcome = await deps.stateSandbox.skillBash({
    skill: deps.skill,
    revision: resolved.revision,
    files: resolved.files,
    installNpmDeps: resolved.installNpmDeps,
    depsHash: resolved.depsHash,
    command: deps.command,
    timeoutMs,
  });
  await deps.recheckAccess();
  await deps.registry.skillRuntimeResolve(deps.scope, deps.skill, deps.snapshot);
  const outputs = await writeSkillOutputs(deps.outputSandbox, deps.skill, outcome.outputs);
  if (deps.scope === "owner" && !outcome.timedOut && outcome.code === 0) {
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
      if (!caller || caller.scope !== host.namespace || (op !== "list" && op !== "bash" && caller.scope !== "owner")) {
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
      if (op !== "list" && op !== "state_list") {
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
        await host.registry.skillRuntimeResolve("owner", skill);
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
        await host.registry.skillRuntimeResolve("owner", skill);
        return host.sandbox("skill-state:" + skill).skillStateList(skill);
      }),
    }),
    defineTool({
      name: "skill_state_clear",
      description: "仅主人交互回合可用：清空指定技能的全部加密登录态文件（含已删除技能的残留状态）。",
      replay: "unsafe",
      structuredOutputSchema: resultSchema,
      parameters: Type.Object({ skill: SkillNameSchema }, strict),
      execute: ({ skill }, api, context) => run(api, context, "state_clear", skill, async () => {
        const res = await host.sandbox("skill-state:" + skill).skillStateClear(skill);
        await host.registry.skillRuntimeAuthResolved(skill);
        return { skill, ...res };
      }),
    }),
    defineTool({
      name: "skill_grant",
      description: "仅主人交互回合可用：授予或撤销指定群使用某技能加密状态沙箱（skill_bash）的权限。",
      replay: "unsafe",
      structuredOutputSchema: resultSchema,
      parameters: Type.Object({
        skill: SkillNameSchema,
        group: SkillGroupSchema,
        enabled: Type.Boolean(),
      }, strict),
      execute: ({ skill, group, enabled }, api, context) => run(api, context, "grant", skill,
        () => host.registry.skillRuntimeGrant(skill, group, enabled), { group, enabled }),
    }),
  ] : [];

  return defineExtension({
    name: "cs.skill-runtime",
    namespace: { name: "skills", description: "技能专属加密状态沙箱与信任群共享授权" },
    tools: [
      ...ownerTools,
      defineTool({
        name: "skill_list",
        description: "列出当前会话已获授权可使用 skill_bash 共享状态沙箱的技能列表。",
        replay: "safe",
        structuredOutputSchema: resultSchema,
        parameters: Type.Object({}, strict),
        execute: (_args, api, context) => run(api, context, "list", "", async caller => ({
          skills: await host.registry.skillRuntimeList(caller.scope),
        })),
      }),
      defineTool({
        name: "skill_bash",
        description: "在技能专属加密状态沙箱中执行命令（群仅限主人已授权的技能）。/opt/skill 为只读 SKILL.md 与技能附件；/work/state（SKILL_STATE_DIR、HOME、XDG_*）保存持久登录态并在正常退出后自动加密写回 R2；/work/out（SKILL_OUT_DIR）中的产物会自动写入 r2://.tmp/...，outputs[].path 可直接传给 send_file({ path })。",
        replay: "unsafe",
        structuredOutputSchema: resultSchema,
        parameters: Type.Object({
          skill: SkillNameSchema,
          command: Type.String({ minLength: 1, maxLength: 16384 }),
          timeoutSec: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })),
        }, strict),
        execute: ({ skill, command, timeoutSec }, api, context) => run(api, context, "bash", skill, caller =>
          executeResolvedSkillBash({
            scope: caller.scope,
            skill,
            command,
            timeoutSec,
            registry: host.registry,
            stateSandbox: host.sandbox("skill-state:" + skill),
            outputSandbox: host.sandbox(caller.scope),
            recheckAccess: () => requireCallerScope(api, context, caller.scope),
          })),
      }),
    ].map(tool => ({ ...tool, callers: ["tools"] as const })),
  });
}

import type { Context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section, type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Static, TSchema } from "typebox";
import type { SandboxDO } from "../sandbox/do";
import { EXEC_MAX_TIMEOUT_MS, sandboxFailure, WORK_ROOT, type SandboxFailure } from "../sandbox/client";

export type SandboxApi = Pick<SandboxDO, "exec" | "readFile" | "writeFile" | "editFile">;
export type CodingAuditKind = "coding_exec" | "coding_read" | "coding_write" | "coding_edit";
export type CodingDeps = {
  /** 只有 owner 亲自发来的消息回合可以用；定时回合虽然看得到工具，调用时也拒绝。 */
  allowed(api: ToolExecutionApi, context: Context): Promise<boolean>;
  sandbox(): SandboxApi;
  /** 审计只记分类、耗时、命令长度与退出码，不记命令、路径、文件内容与输出。 */
  record(kind: CodingAuditKind, detail: object): Promise<unknown>;
};

const DEFAULT_TIMEOUT_S = 60;
const FAILURES: Record<SandboxFailure, string> = {
  container_budget_unavailable: "容器预算服务暂时不可用，本次没有启动新容器。",
  container_budget_exceeded: "今日全项目容器预算已用完；请稍后再运行，已提交文件仍保留。",
  container_budget_busy: "全项目已有两个容器占用预算，请稍后再运行。",
  container_budget_expired: "本次容器的5分钟硬期限已到；不会自动重跑命令，已提交文件仍保留。",
  workspace_storage_unavailable: "持久资产存储未配置；不能继续写入。",
  workspace_quota: "工作区快照被拒绝：单文件最多10MiB，总量最多50MiB，不能包含符号链接；本次文件变更没有提交，请缩小工作集。",
  persistence_failed: "命令已执行，但持久化失败；文件变更未确认，不能当作成功，也不要盲目重跑有副作用的命令。",
  operation_unknown: "命令结果不确定，系统不会自动重新运行；请先检查外部副作用与已提交文件。",
  operation_expired: "该操作早已执行，详细结果已过期；不会重新运行。",
  operation_conflict: "同一个操作ID不能执行不同参数。",
  workspace_conflict: "工作区版本已改变，请重新查看版本后合并。",
  blob_corrupt: "持久文件校验失败，工作区未提交。",
  restore_incomplete: "工作区恢复尚未完成，不能执行命令。",
  sandbox_unavailable: "沙箱容器暂时起不来，请稍后再试；一直不行就告诉主人。",
  path_denied: `路径只能在 ${WORK_ROOT} 下，也不能经符号链接指到外面。`,
  not_found: "文件或目录不存在。",
  is_directory: "这是目录；用 bash 的 ls 查看。",
  not_a_directory: "工作目录不存在或不是目录。",
  binary_file: "这是非图片二进制文件；可以用 bash（file、xxd 等）查看。",
  too_large: "文件超过 10 MiB；用 bash 的 head、tail、grep 分段查看。",
  offset_out_of_range: "offset 超过了文件总行数。",
  edit_not_found: "有一处 oldText 在文件里找不到；先 read 确认原文（含空白与缩进）。",
  edit_ambiguous: "有一处 oldText 在文件里出现不止一次；带上更多上下文让它唯一。",
  edit_overlap: "几处 edits 互相重叠；合并成一处。",
  permission_denied: "没有权限。",
  invalid_request: "参数无效。",
  sandbox_error: "沙箱返回了意外错误。",
};
const NOT_ALLOWED = "只有主人亲自发消息的回合可以使用沙箱工具；本回合请先告诉主人。";
export const SANDBOX_RULE = `沙箱：read / write / edit / bash 作用在本会话的 Linux 沙箱（Debian，带 python3、node、git、curl），工作目录 ${WORK_ROOT}，路径只能在 ${WORK_ROOT} 下。` +
  `沙箱空闲 3 分钟后停止，已成功提交的 ${WORK_ROOT} 文件会从私有存储恢复；单文件最多10MiB，工作区总量最多50MiB，不支持符号链接。产物写到 ${WORK_ROOT}/out/，可用 send_file 发送。` +
  `网络可用，但不要下载大文件或安装大型依赖；单条命令最长 ${EXEC_MAX_TIMEOUT_MS / 1000} 秒，不要起常驻服务。只有主人亲自发消息的回合可用。`;

const text = (value: string, isError = false): ToolExecutionResult => ({ ...(isError ? { isError } : {}), output: [{ type: "text", text: value }] });

type CodingTool<P extends TSchema> = Omit<ToolRegistration<P>, "execute"> & {
  kind: CodingAuditKind;
  /** 调用前就能确定的审计字段（如命令长度），失败时也要记。 */
  audit?(args: Static<P>): object;
  run(args: Static<P>, sandbox: SandboxApi, api: ToolExecutionApi): Promise<{ result: ToolExecutionResult; outcome?: string; audit?: object }>;
};

function codingTool<P extends TSchema>(deps: CodingDeps, { kind, audit, run, ...tool }: CodingTool<P>) {
  return defineTool({
    ...tool,
    execute: async (args, api, context) => {
      if (!await deps.allowed(api, context)) return text(NOT_ALLOWED, true);
      const started = Date.now(), before = audit?.(args) ?? {};
      try {
        const { result, outcome, audit: after } = await run(args, deps.sandbox(), api);
        await deps.record(kind, { result: outcome ?? "ok", ...before, ...after, ms: Date.now() - started });
        return result;
      } catch (error) {
        const code = sandboxFailure(error);
        await deps.record(kind, { result: code, ...before, ms: Date.now() - started });
        const detail = code === "workspace_quota" && error instanceof Error && error.message.includes(":") ? `\n${error.message.slice(error.message.indexOf(":") + 1, 1800)}` : "";
        return text(`${code}：${FAILURES[code]}${detail}`, true);
      }
    },
  });
}

const EditParams = Type.Object({
  path: Type.String({ minLength: 1, description: "Path to the file to edit (relative to /work or absolute)" }),
  edits: Type.Array(Type.Object({
    oldText: Type.String({ minLength: 1, description: "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call." }),
    newText: Type.String({ description: "Replacement text for this targeted edit." }),
  }, { additionalProperties: false }), { minItems: 1, description: "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead." }),
}, { additionalProperties: false });

/** 与 Docker 版 edit 一样修正模型常见的错形状：edits 给成 JSON 字符串或单个对象，或者直接在顶层给 oldText/newText。 */
function prepareEditArguments(input: unknown): Static<typeof EditParams> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input as Static<typeof EditParams>;
  const args: Record<string, unknown> = { ...input };
  if (typeof args.edits === "string") { try { args.edits = JSON.parse(args.edits); } catch { /* 留给参数校验报错 */ } }
  if (args.edits && typeof args.edits === "object" && !Array.isArray(args.edits)) args.edits = [args.edits];
  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    args.edits = [...Array.isArray(args.edits) ? args.edits : [], { oldText: args.oldText, newText: args.newText }];
    delete args.oldText;
    delete args.newText;
  }
  return args as Static<typeof EditParams>;
}

export function createCodingExtension(deps: CodingDeps) {
  const tools = [
    codingTool(deps, {
      name: "read", kind: "coding_read", replay: "safe",
      description: `Read the contents of a text file in the sandbox. Output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete. Relative paths resolve against ${WORK_ROOT}.`,
      parameters: Type.Object({
        path: Type.String({ minLength: 1, description: `Path to the file to read (relative to ${WORK_ROOT} or absolute)` }),
        offset: Type.Optional(Type.Integer({ minimum: 1, description: "Line number to start reading from (1-indexed)" })),
        limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines to read" })),
      }, { additionalProperties: false }),
      run: async ({ path, offset, limit }, sandbox) => {
        const file = await sandbox.readFile(path, { offset, limit });
        if ("kind" in file) return { result: { output: [{ type: "image", data: file.data, mimeType: file.mimeType }] } };
        const more = file.endLine < file.totalLines ? `\n\n[Showing lines ${file.startLine}-${file.endLine} of ${file.totalLines}. Use offset=${file.endLine + 1} to continue.]` : "";
        return { result: text((file.text || "(empty)") + more) };
      },
    }),
    codingTool(deps, {
      name: "write", kind: "coding_write", replay: "safe",
      description: "Write content to a file in the sandbox. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
      parameters: Type.Object({
        path: Type.String({ minLength: 1, description: `Path to the file to write (relative to ${WORK_ROOT} or absolute)` }),
        content: Type.String({ description: "Content to write to the file" }),
      }, { additionalProperties: false }),
      run: async ({ path, content }, sandbox, api) => {
        const { bytes } = await sandbox.writeFile(path, content, `task:${api.taskId}`);
        return { result: text(`Successfully wrote ${bytes} bytes to ${path}`) };
      },
    }),
    codingTool(deps, {
      name: "edit", kind: "coding_edit", replay: "safe",
      description: "Edit a single file in the sandbox using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
      parameters: EditParams,
      prepareArguments: prepareEditArguments,
      run: async ({ path, edits }, sandbox, api) => {
        const { replaced } = await sandbox.editFile(path, edits, `task:${api.taskId}`);
        return { result: text(`Successfully replaced ${replaced} block(s) in ${path}.`) };
      },
    }),
    codingTool(deps, {
      name: "bash", kind: "coding_exec",
      // 命令有副作用，中断后不自动重放。
      replay: "unsafe",
      description: `Execute a bash command in the sandbox, in ${WORK_ROOT}. Returns stdout, stderr and the exit code; each stream keeps only its last 64KB. Each command has a maximum duration of ${EXEC_MAX_TIMEOUT_MS / 1000} seconds; omitting timeout uses ${DEFAULT_TIMEOUT_S} seconds.`,
      parameters: Type.Object({
        command: Type.String({ minLength: 1, description: "Bash command to execute" }),
        timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: EXEC_MAX_TIMEOUT_MS / 1000,
          description: `Timeout in seconds (optional, defaults to ${DEFAULT_TIMEOUT_S} seconds, maximum ${EXEC_MAX_TIMEOUT_MS / 1000} seconds).` })),
      }, { additionalProperties: false }),
      outputLimits: { retain: "tail" },
      audit: ({ command }) => ({ commandLength: command.length }),
      run: async ({ command, timeout }, sandbox, api) => {
        const seconds = timeout ?? DEFAULT_TIMEOUT_S;
        const run = await sandbox.exec(command, { cwd: WORK_ROOT, timeoutMs: Math.ceil(seconds * 1000), operationId: `task:${api.taskId}` });
        const status = run.timedOut ? `Command timed out after ${seconds} seconds` : run.code === 0 ? "" : `Command exited with code ${run.code}`;
        const body = [run.stdout, run.stderr ? `[stderr]\n${run.stderr}` : "", status].filter(Boolean).join("\n");
        return { result: text(body || "(no output)", status !== ""), outcome: run.timedOut ? "timeout" : "ok", audit: { code: run.code } };
      },
    }),
  ];
  return defineExtension({
    name: "cs.coding",
    // 只在本次请求真的提供了 bash 时说明沙箱；事件回合按档位过滤掉了这些工具。
    sections: [section("sandbox", ({ agent }) => agent.tools.some(tool => tool.name === "bash") ? SANDBOX_RULE : undefined, { tag: false })],
    tools: tools.map(tool => ({ ...tool, callers: ["model"] as const })),
  });
}

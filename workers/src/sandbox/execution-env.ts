import type { Context } from "@earendil-works/chord/context";
import { ExecutionError, FileError, type ExecutionEnv, type FileErrorCode, type Result } from "@earendil-works/pi-durable/env";
import type { SandboxDO } from "./do";
import { FILE_MAX_BYTES } from "../media/model";
import { workPath } from "./client";

export type WorkspaceFiles = Pick<SandboxDO, "readBlob" | "writeFile" | "createTempDir">;
/** Code Mode 输出用的文件环境；每次实际操作重新取得授权，复用已提交的工作区文件。 */
export function workspaceExecutionEnv(options: {
  id: string; cwd?: string; files(context: Context): Promise<WorkspaceFiles>;
}): ExecutionEnv {
  const unsupported = async (): Promise<Result<never, FileError>> => ({ ok: false, error: new FileError("not_supported", "此工作区环境尚不支持该文件操作") });
  const boundary = async <T>(context: Context, work: (files: WorkspaceFiles) => Promise<T>): Promise<Result<T, FileError>> => {
    try {
      context.abortSignal?.throwIfAborted();
      const files = await options.files(context);
      context.abortSignal?.throwIfAborted();
      return { ok: true, value: await work(files) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "workspace_error";
      const code: FileErrorCode = context.abortSignal?.aborted ? "aborted"
        : ["permission_denied", "delegation_denied", "path_denied"].includes(message) ? "permission_denied"
        : message === "not_found" ? "not_found" : message === "is_directory" ? "is_directory"
        : message === "not_a_directory" ? "not_directory" : message === "invalid_request" ? "invalid" : "unknown";
      return { ok: false, error: new FileError(code, message, undefined, error instanceof Error ? error : undefined) };
    }
  };
  const path = (value: string) => workPath(value.startsWith("/") ? value : `${environment.cwd}/${value}`);
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: false });
  const environment: ExecutionEnv = {
    id: options.id, cwd: workPath(options.cwd ?? "/work"),
    absolutePath: (value, context) => boundary(context, async () => path(value)),
    joinPath: (parts, context) => boundary(context, async () => path(parts.join("/"))),
    readBinaryFile: (value, context) => boundary(context, async files => (await files.readBlob(path(value))).bytes),
    readTextFile: (value, context) => boundary(context, async files => decoder.decode((await files.readBlob(path(value))).bytes)),
    readTextLines: (value, limits, context) => boundary(context, async files => {
      const lines = decoder.decode((await files.readBlob(path(value))).bytes).split(/\r?\n/);
      return limits?.maxLines === undefined ? lines : lines.slice(0, limits.maxLines);
    }),
    writeFile: (value, content, context) => boundary(context, async files => {
      const bytes = typeof content === "string" ? new TextEncoder().encode(content).byteLength : content.byteLength;
      if (bytes > FILE_MAX_BYTES) throw new Error("too_large");
      await files.writeFile(path(value), content);
    }),
    createTempDir: (prefix, context) => boundary(context, files => files.createTempDir(prefix)),
    createTempFile: (settings, context) => boundary(context, async files => {
      if (settings?.suffix && !/^\.[a-zA-Z0-9_-]{1,32}$/.test(settings.suffix)) throw new Error("invalid_request");
      const directory = await files.createTempDir(settings?.prefix);
      const target = `${directory}/output${settings?.suffix ?? ""}`;
      await files.writeFile(target, new Uint8Array());
      return target;
    }),
    openTextLineReader: unsupported, openBinaryReader: unsupported, appendFile: unsupported,
    truncateFile: unsupported, flushFile: unsupported, renameFile: unsupported, fileInfo: unsupported,
    listDir: unsupported, openDirReader: unsupported, watch: unsupported, canonicalPath: unsupported,
    exists: unsupported, createDir: unsupported, remove: unsupported,
    exec: async () => ({ ok: false, error: new ExecutionError("shell_unavailable", "使用现有 bash 工具执行工作区命令") }),
    // 文件需留给后续回合读取/发送；不随 Harness 关闭删除，由输出目录的保留策略清理。
    cleanup: async () => {},
  };
  return environment;
}

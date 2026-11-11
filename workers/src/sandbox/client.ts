/** CF 运行时契约；实现使用官方 Files 与原生 Container.exec，不对外开放控制端口。 */
export const WORK_ROOT = "/work";
export const EXEC_MAX_TIMEOUT_MS = 120_000;

// 失败一律以这些分类码作为 Error.message 抛出；RPC 会保留 message，工具按它给模型说明。
export const SANDBOX_FAILURES = ["sandbox_unavailable", "path_denied", "not_found", "is_directory", "not_a_directory", "binary_file", "too_large",
  "workspace_storage_unavailable", "workspace_quota", "persistence_failed", "operation_unknown", "operation_expired", "operation_conflict", "workspace_conflict", "blob_corrupt", "restore_incomplete", "offset_out_of_range", "edit_not_found", "edit_ambiguous", "edit_overlap", "permission_denied", "invalid_request", "sandbox_error"] as const;
export type SandboxFailure = typeof SANDBOX_FAILURES[number];
const known = (code: unknown): SandboxFailure => SANDBOX_FAILURES.find(item => item === code) ?? "sandbox_error";
export const sandboxFailure = (error: unknown): SandboxFailure => known(error instanceof Error ? error.message.split(":")[0] : undefined);

export type ExecResult = { stdout: string; stderr: string; code: number | null; timedOut: boolean; truncated: boolean };
export type TextReadResult = { text: string; startLine: number; endLine: number; totalLines: number };
export type ImageReadResult = { kind: "image"; data: string; mimeType: string };
export type ReadResult = TextReadResult | ImageReadResult;
export type RuntimeFile = { path: string; sha256: string; bytes: number; mime: string; mode: number };
export type RuntimeSnapshot = { files: RuntimeFile[]; directories: string[]; totalBytes: number };
export class SandboxError extends Error { constructor(code: string, readonly issues?: unknown) { super(code); } }
export type FileEdit = { oldText: string; newText: string };
export type DirEntry = { name: string; type: "file" | "dir" | "link" | "other"; size: number };

/** 模型路径按 /work 解析；词法上出了 /work 就不发给容器，固定本地助手再核验 realpath。 */
export function workPath(raw: string): string {
  if (raw.includes("\0")) throw new Error("invalid_request");
  const parts: string[] = [];
  for (const part of (raw.startsWith("/") ? raw : `${WORK_ROOT}/${raw}`).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") { if (!parts.pop()) throw new Error("path_denied"); continue; }
    parts.push(part);
  }
  const path = "/" + parts.join("/");
  if (path !== WORK_ROOT && !path.startsWith(WORK_ROOT + "/")) throw new Error("path_denied");
  return path;
}

/** 新建 .git、node_modules、.wrangler 只留在当前容器；旧清单已追踪的缓存继续保存。 */
export interface SandboxClient {
  snapshot(retainedPaths?: readonly string[]): Promise<RuntimeSnapshot>;
  readBlob(path: string): Promise<Uint8Array>;
  restore(snapshot: RuntimeSnapshot, readBlob: (file: RuntimeFile) => Promise<Uint8Array>): Promise<void>;
  exec(cmd: string, options: { cwd?: string; timeoutMs: number }): Promise<ExecResult>;
  readFile(path: string, options?: { offset?: number; limit?: number }): Promise<ReadResult>;
  writeFile(path: string, content: string | Uint8Array): Promise<{ bytes: number }>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  editFile(path: string, edits: FileEdit[]): Promise<{ replaced: number }>;
  list(path: string): Promise<DirEntry[]>;
}

/** 沙箱控制服务（sandbox/server.mjs）的 HTTP 协议：SandboxDO 把它接到容器端口，测试接到伪造的 fetch。 */
export const WORK_ROOT = "/work";
export const EXEC_MAX_TIMEOUT_MS = 120_000;

// 失败一律以这些分类码作为 Error.message 抛出；RPC 会保留 message，工具按它给模型说明。
export const SANDBOX_FAILURES = ["sandbox_unavailable", "path_denied", "not_found", "is_directory", "not_a_directory", "binary_file", "too_large",
  "offset_out_of_range", "edit_not_found", "edit_ambiguous", "edit_overlap", "permission_denied", "invalid_request", "sandbox_error"] as const;
export type SandboxFailure = typeof SANDBOX_FAILURES[number];
const known = (code: unknown): SandboxFailure => (SANDBOX_FAILURES as readonly unknown[]).includes(code) ? code as SandboxFailure : "sandbox_error";
export const sandboxFailure = (error: unknown): SandboxFailure => known(error instanceof Error ? error.message : undefined);

export type ExecResult = { stdout: string; stderr: string; code: number | null; timedOut: boolean; truncated: boolean };
export type ReadResult = { text: string; startLine: number; endLine: number; totalLines: number };
export type FileEdit = { oldText: string; newText: string };
export type DirEntry = { name: string; type: "file" | "dir" | "link" | "other"; size: number };

/** 模型给的路径按 /work 解析成规范绝对路径；词法上出了 /work 就不发给容器。符号链接由控制服务按 realpath 再查。 */
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

export type ControlFetch = (path: string, init?: RequestInit) => Promise<Response>;

export function sandboxClient(send: ControlFetch) {
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await send(path, init);
    const body = await response.json<T & { error?: string }>().catch(() => undefined);
    if (!response.ok || body === undefined) throw new Error(known(body?.error));
    return body;
  }
  const post = (body: object): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const query = (params: Record<string, string | number | undefined>) =>
    new URLSearchParams(Object.entries(params).flatMap(([key, value]) => value === undefined ? [] : [[key, String(value)]])).toString();
  return {
    async exec(cmd: string, options: { cwd?: string; timeoutMs: number }): Promise<ExecResult> {
      return call("/exec", post({ cmd, cwd: workPath(options.cwd ?? WORK_ROOT), timeoutMs: Math.min(EXEC_MAX_TIMEOUT_MS, Math.max(1, Math.trunc(options.timeoutMs))) }));
    },
    async readFile(path: string, options: { offset?: number; limit?: number } = {}): Promise<ReadResult> {
      return call(`/file?${query({ path: workPath(path), offset: options.offset, limit: options.limit })}`);
    },
    async writeFile(path: string, text: string): Promise<{ bytes: number }> {
      return call(`/file?${query({ path: workPath(path) })}`, { method: "PUT", body: text });
    },
    async editFile(path: string, edits: FileEdit[]): Promise<{ replaced: number }> {
      return call("/edit", post({ path: workPath(path), edits }));
    },
    async list(path: string): Promise<DirEntry[]> {
      return call(`/ls?${query({ path: workPath(path) })}`);
    },
  };
}
export type SandboxClient = ReturnType<typeof sandboxClient>;

import { Files, SandboxFileError, SandboxProtocolError } from "@cloudflare/sandbox";
import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { FILE_MAX_BYTES } from "../media/model";
import { decodeFileRead } from "./read";
import { EXEC_MAX_TIMEOUT_MS, WORK_ROOT, SandboxError, sandboxFailure, workPath, type SandboxClient } from "./client";

export type NativeContainer = Pick<Container, "exec">;
export type NativeFiles = Pick<Files, "readFile" | "writeFile" | "stat" | "readDirectory" | "mkdir" | "remove">;
type Dependencies = { container(): Promise<NativeContainer>; files?(container: NativeContainer): NativeFiles };
const user = "1000:1000", strict = { additionalProperties: false };
const File = Type.Object({ path: Type.String(), sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }), bytes: Type.Integer({ minimum: 0, maximum: FILE_MAX_BYTES }), mime: Type.String(), mode: Type.Integer({ minimum: 0, maximum: 511 }) }, strict);
const Snapshot = Type.Object({ files: Type.Array(File), directories: Type.Array(Type.String()), totalBytes: Type.Integer({ minimum: 0 }) }, strict);
const Exec = Type.Object({ stdout: Type.String(), stderr: Type.String(), code: Type.Union([Type.Integer(), Type.Null()]), timedOut: Type.Boolean(), truncated: Type.Boolean() }, strict);
const Failure = Type.Object({ error: Type.String(), issues: Type.Optional(Type.Unknown()) }, strict);
const Restored = Type.Object({ restored: Type.Literal(true) }, strict);
const decoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: false });
const encoder = new TextEncoder();

/** 运行时只有 Files 和原生进程入口。缓存只驻留当前容器，旧 manifest 已追踪的缓存路径仍保留。 */
export function nativeSandboxClient(deps: Dependencies): SandboxClient {
  function failure(error: unknown): never {
    if (error instanceof SandboxError) throw error;
    const code = sandboxFailure(error);
    if (code !== "sandbox_error") throw new SandboxError(code);
    if (SandboxFileError.is(error)) {
      const codes: Record<string, string> = { ENOENT: "not_found", EISDIR: "is_directory", ENOTDIR: "not_a_directory", EACCES: "permission_denied", EPERM: "permission_denied", ELOOP: "path_denied" };
      throw new SandboxError(codes[error.code] ?? "sandbox_error");
    }
    if (SandboxProtocolError.is(error)) throw new SandboxError("sandbox_unavailable");
    throw new SandboxError("sandbox_unavailable");
  }
  async function boundary<T>(work: () => Promise<T>): Promise<T> { try { return await work(); } catch (error) { return failure(error); } }
  async function files(): Promise<NativeFiles> {
    const container = await deps.container();
    return deps.files ? deps.files(container) : new Files(container);
  }
  async function helper<S extends TSchema>(action: string, input: object, schema: S, timeoutMs = EXEC_MAX_TIMEOUT_MS): Promise<Static<S>> {
    return boundary(async () => {
      const container = await deps.container();
      // 助手由 root 保护；exec 子命令会以 uid/gid 1000 派生 bash，模型不能杀掉封存结果的父进程。
      const process = await container.exec(["/usr/local/bin/node", "/opt/sandbox/runtime.mjs", action], {
        user: "0:0", cwd: WORK_ROOT, env: { PATH: "/usr/local/bin:/usr/bin:/bin" }, signal: AbortSignal.timeout(timeoutMs + 3000),
        stdin: new Blob([JSON.stringify(input)]).stream(), stdout: "pipe", stderr: "pipe",
      });
      const output = await process.output();
      let value: unknown;
      try { value = JSON.parse(decoder.decode(output.stdout)); } catch { throw new SandboxError("sandbox_unavailable"); }
      if (Check(Failure, value)) throw new SandboxError(sandboxFailure(new Error(value.error)), value.issues);
      if (output.exitCode !== 0 || !Check(schema, value)) throw new SandboxError("sandbox_unavailable");
      return value;
    });
  }
  const resolve = (path: string) => helper("resolve", { path: workPath(path) }, Type.String({ pattern: "^/work(?:/|$)" }));
  async function bytes(path: string): Promise<Uint8Array> {
    const absolute = await resolve(path), fs = await files();
    const stat = await fs.stat(absolute, { user });
    if (stat.type === "directory") throw new SandboxError("is_directory");
    if (stat.type !== "file") throw new SandboxError("binary_file");
    if (stat.size > BigInt(FILE_MAX_BYTES)) throw new SandboxError("too_large");
    const response = await fs.readFile(absolute, { user });
    const result = new Uint8Array(await response.arrayBuffer());
    if (result.byteLength > FILE_MAX_BYTES) throw new SandboxError("too_large");
    return result;
  }
  async function write(path: string, text: string): Promise<{ bytes: number }> {
    const absolute = await resolve(path), fs = await files();
    await fs.mkdir(absolute.slice(0, absolute.lastIndexOf("/")), { recursive: true, user });
    await fs.writeFile(absolute, text, { user });
    return { bytes: encoder.encode(text).byteLength };
  }
  return {
    snapshot: (retainedPaths = []) => helper("snapshot", { retainedPaths }, Snapshot),
    readBlob: path => boundary(() => bytes(path)),
    restore: (snapshot, readBlob) => boundary(async () => {
      const stage = "/tmp/sandbox-import-" + crypto.randomUUID(), fs = await files();
      await fs.mkdir(stage, { user });
      try {
        for (const file of snapshot.files) {
          const relative = workPath(file.path).slice(WORK_ROOT.length + 1);
          if (!relative) throw new SandboxError("path_denied");
          const target = `${stage}/${relative}`;
          await fs.mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true, user });
          await fs.writeFile(target, await readBlob(file), { user });
        }
        await helper("restore", { stage, snapshot }, Restored);
      } finally { await fs.remove(stage, { recursive: true, force: true, user }); }
    }),
    exec: (command, options) => {
      if (!Number.isFinite(options.timeoutMs)) return Promise.reject(new SandboxError("invalid_request"));
      const timeoutMs = Math.min(EXEC_MAX_TIMEOUT_MS, Math.max(1, Math.trunc(options.timeoutMs)));
      return helper("exec", { command, cwd: workPath(options.cwd ?? WORK_ROOT), timeoutMs }, Exec, timeoutMs);
    },
    readFile: (path, options = {}) => boundary(async () => decodeFileRead(await bytes(path), options)),
    writeFile: (path, text) => boundary(() => write(path, text)),
    editFile: (path, edits) => boundary(async () => {
      if (!edits.length || edits.some(edit => !edit.oldText)) throw new SandboxError("invalid_request");
      const original = await bytes(path);
      if (original.includes(0)) throw new SandboxError("binary_file");
      // ignoreBOM=true 保留 U+FEFF，替换不改变原 UTF-8 BOM 或 CRLF。
      const content = decoder.decode(original);
      const spans = edits.map(({ oldText, newText }) => {
        const at = content.indexOf(oldText);
        if (at < 0) throw new SandboxError("edit_not_found");
        if (content.indexOf(oldText, at + 1) >= 0) throw new SandboxError("edit_ambiguous");
        return { at, end: at + oldText.length, newText };
      }).sort((a, b) => a.at - b.at);
      if (spans.some((span, index) => index > 0 && span.at < spans[index - 1].end)) throw new SandboxError("edit_overlap");
      let result = "", cursor = 0;
      for (const span of spans) { result += content.slice(cursor, span.at) + span.newText; cursor = span.end; }
      await write(path, result + content.slice(cursor));
      return { replaced: spans.length };
    }),
    list: path => boundary(async () => {
      const absolute = await resolve(path), fs = await files();
      if ((await fs.stat(absolute, { user })).type !== "directory") throw new SandboxError("not_a_directory");
      return Promise.all((await fs.readDirectory(absolute, { user })).slice(0, 1000).map(async entry => ({
        name: entry.name, type: entry.type === "symlink" ? "link" : entry.type === "directory" ? "dir" : entry.type === "file" ? "file" : "other",
        size: entry.type === "file" ? Number((await fs.stat(`${absolute}/${entry.name}`, { user })).size) : 0,
      })));
    }),
  };
}

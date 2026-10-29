// 沙箱容器里的控制服务：SandboxDO 经 getTcpPort(3000) 调它。容器端口只有绑定的 DO 能到达，所以不另做鉴权。
// 服务以 root 运行，命令降到 sandbox 用户执行：模型跑的命令杀不掉服务，也改不了 /opt/sandbox。
import http from "node:http";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const OUTPUT_CAP = 64 * 1024;
export const MAX_TIMEOUT_MS = 120_000;
const READ_MAX_LINES = 2000, READ_MAX_BYTES = 50 * 1024, FILE_MAX_BYTES = 10 * 1024 * 1024, BODY_MAX_BYTES = 16 * 1024 * 1024;
const LIST_MAX = 1000;

class Failure extends Error {
  constructor(code, status = 400) { super(code); this.status = status; }
}

export const within = (root, file) => {
  const relative = path.relative(root, file);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
};

/** 新文件解析到最近存在的父目录；悬空链接也解析目标，不能借 write 建到 /work 外面。 */
async function realpathLoose(file, depth = 0) {
  if (depth > 40) throw new Failure("path_denied");
  try { return await fs.realpath(file); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const link = await fs.lstat(file).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (link?.isSymbolicLink()) return realpathLoose(path.resolve(path.dirname(file), await fs.readlink(file)), depth + 1);
  const parent = path.dirname(file);
  if (parent === file) throw new Failure("path_denied");
  return path.join(await realpathLoose(parent, depth + 1), path.basename(file));
}

/** 词法上与 realpath 上都必须在工作区内；返回 realpath，后续操作不再经过链接。 */
export async function resolveInside(root, raw) {
  if (typeof raw !== "string" || !raw || raw.includes("\0")) throw new Failure("invalid_request");
  const absolute = path.resolve(root, raw);
  if (!within(root, absolute)) throw new Failure("path_denied");
  const real = await realpathLoose(absolute);
  if (!within(await fs.realpath(root), real)) throw new Failure("path_denied");
  return real;
}

/** 只留末尾 cap 字节：报错和结果通常在输出的最后。 */
export function tailCollector(cap = OUTPUT_CAP) {
  const chunks = [];
  let kept = 0, dropped = 0;
  return {
    push(chunk) {
      chunks.push(chunk);
      kept += chunk.length;
      while (kept - chunks[0].length >= cap) { kept -= chunks[0].length; dropped += chunks.shift().length; }
    },
    result() {
      let bytes = Buffer.concat(chunks), skipped = dropped;
      if (bytes.length > cap) { skipped += bytes.length - cap; bytes = bytes.subarray(bytes.length - cap); }
      // 截断点可能落在多字节字符中间，跳过残缺的续字节。
      let start = 0;
      if (skipped) while (start < bytes.length && start < 3 && (bytes[start] & 0xc0) === 0x80) start++;
      const text = bytes.subarray(start).toString("utf8");
      return { text: skipped ? `[前 ${skipped + start} 字节已省略]\n${text}` : text, truncated: skipped > 0 };
    },
  };
}

function readStat(file) {
  return fs.stat(file).catch(error => { throw error.code === "ENOENT" ? new Failure("not_found", 404) : error; });
}

export function createSandboxServer({ root, shell = "/bin/bash", user, env = {} }) {
  const commandEnv = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", TERM: "dumb", ...env };

  // 服务以 root 写入的新文件与目录要交给 sandbox 用户，否则命令改不了它们。
  async function own(file, created) {
    if (!user) return;
    for (let current = file; ; current = path.dirname(current)) {
      await fs.chown(current, user.uid, user.gid);
      if (!created || current === created || !within(created, current)) return;
    }
  }

  async function exec({ cmd, cwd, timeoutMs }) {
    const timeout = timeoutMs ?? 60_000;
    if (typeof cmd !== "string" || !cmd.trim() || !Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) throw new Failure("invalid_request");
    const dir = await resolveInside(root, cwd ?? root);
    if (!(await readStat(dir)).isDirectory()) throw new Failure("not_a_directory");
    return new Promise(resolve => {
      const child = spawn(shell, ["-c", cmd], { cwd: dir, env: commandEnv, detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"], ...(user ? { uid: user.uid, gid: user.gid } : {}) });
      const stdout = tailCollector(), stderr = tailCollector();
      let timedOut = false, settled = false;
      const kill = () => {
        // 整个进程组一起杀，命令派生的子进程不能在超时后继续跑。
        try { if (process.platform === "win32") child.kill("SIGKILL"); else process.kill(-child.pid, "SIGKILL"); } catch { /* 已退出 */ }
      };
      const timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
      const finish = (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const out = stdout.result(), err = stderr.result();
        resolve({ stdout: out.text, stderr: err.text, code: timedOut ? null : code, signal: signal ?? null, timedOut, truncated: out.truncated || err.truncated });
      };
      child.stdout.on("data", chunk => stdout.push(chunk));
      child.stderr.on("data", chunk => stderr.push(chunk));
      child.on("error", error => { stderr.push(Buffer.from(error.message)); finish(127, null); });
      child.on("close", finish);
      // shell 退出后，留在后台的进程可能还握着管道；再等一秒就收尾，不让 `server &` 拖到超时。
      child.on("exit", (code, signal) => setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(code, signal); }, 1000).unref());
    });
  }

  async function read({ path: raw, offset, limit }) {
    const start = offset === undefined ? 0 : offset - 1;
    if (!Number.isInteger(start) || start < 0 || (limit !== undefined && (!Number.isInteger(limit) || limit < 1))) throw new Failure("invalid_request");
    const file = await resolveInside(root, raw), stat = await readStat(file);
    if (stat.isDirectory()) throw new Failure("is_directory");
    if (stat.size > FILE_MAX_BYTES) throw new Failure("too_large");
    const bytes = await fs.readFile(file);
    if (bytes.includes(0)) throw new Failure("binary_file");
    const lines = bytes.toString("utf8").split("\n");
    if (start >= lines.length) throw new Failure("offset_out_of_range");
    const end = limit === undefined ? lines.length : Math.min(lines.length, start + limit);
    const taken = [];
    let size = 0;
    for (let index = start; index < end && taken.length < READ_MAX_LINES; index++) {
      const line = lines[index], lineBytes = Buffer.byteLength(line) + 1;
      if (size + lineBytes > READ_MAX_BYTES) {
        // 单行就超限时给出它的开头，否则 offset 永远前进不了。
        if (!taken.length) taken.push(Buffer.from(line).subarray(0, READ_MAX_BYTES).toString("utf8"));
        break;
      }
      taken.push(line);
      size += lineBytes;
    }
    return { text: taken.join("\n"), startLine: start + 1, endLine: start + taken.length, totalLines: lines.length };
  }

  async function write(raw, content) {
    const file = await resolveInside(root, raw);
    const created = await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    await own(file, created);
    return { bytes: content.length };
  }

  async function edit({ path: raw, edits }) {
    if (!Array.isArray(edits) || !edits.length || edits.some(edit => typeof edit?.oldText !== "string" || !edit.oldText || typeof edit.newText !== "string")) {
      throw new Failure("invalid_request");
    }
    const file = await resolveInside(root, raw), stat = await readStat(file);
    if (stat.isDirectory()) throw new Failure("is_directory");
    const content = await fs.readFile(file, "utf8");
    // 每处替换都按原文定位，必须唯一且互不重叠，与 Docker 版 edit 工具的约定一致。
    const spans = edits.map(({ oldText, newText }) => {
      const at = content.indexOf(oldText);
      if (at < 0) throw new Failure("edit_not_found");
      if (content.indexOf(oldText, at + 1) >= 0) throw new Failure("edit_ambiguous");
      return { at, end: at + oldText.length, newText };
    }).sort((a, b) => a.at - b.at);
    if (spans.some((span, index) => index > 0 && span.at < spans[index - 1].end)) throw new Failure("edit_overlap");
    let result = "", cursor = 0;
    for (const span of spans) { result += content.slice(cursor, span.at) + span.newText; cursor = span.end; }
    await fs.writeFile(file, result + content.slice(cursor));
    return { replaced: spans.length };
  }

  async function list(raw) {
    const dir = await resolveInside(root, raw);
    if (!(await readStat(dir)).isDirectory()) throw new Failure("not_a_directory");
    const entries = (await fs.readdir(dir, { withFileTypes: true })).slice(0, LIST_MAX);
    return Promise.all(entries.map(async entry => ({
      name: entry.name,
      type: entry.isSymbolicLink() ? "link" : entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other",
      size: entry.isFile() ? (await fs.lstat(path.join(dir, entry.name))).size : 0,
    })));
  }

  async function body(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > BODY_MAX_BYTES) throw new Failure("too_large");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  async function json(request) {
    const bytes = await body(request);
    try { return JSON.parse(bytes.toString("utf8")) ?? {}; } catch { throw new Failure("invalid_request"); }
  }
  const optionalInt = value => value === null ? undefined : Number(value);

  const routes = {
    "GET /health": async () => ({ ok: true }),
    "POST /exec": async request => exec(await json(request)),
    "GET /file": async (_request, url) => read({ path: url.searchParams.get("path"), offset: optionalInt(url.searchParams.get("offset")), limit: optionalInt(url.searchParams.get("limit")) }),
    "PUT /file": async (request, url) => write(url.searchParams.get("path"), await body(request)),
    "POST /edit": async request => edit(await json(request)),
    "GET /ls": async (_request, url) => list(url.searchParams.get("path") ?? root),
  };

  return http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://sandbox");
    const route = routes[`${request.method} ${url.pathname}`];
    let status = 200, payload;
    try {
      if (!route) throw new Failure("not_found", 404);
      payload = await route(request, url);
    } catch (error) {
      if (error instanceof Failure) { status = error.status; payload = { error: error.message }; }
      else if (error?.code === "EACCES" || error?.code === "EPERM") { status = 403; payload = { error: "permission_denied" }; }
      else { status = 500; payload = { error: "internal" }; console.error(error); }
    }
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(payload));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const user = process.getuid?.() === 0 ? { uid: Number(process.env.SANDBOX_UID ?? 1000), gid: Number(process.env.SANDBOX_GID ?? 1000) } : undefined;
  createSandboxServer({ root: process.env.SANDBOX_ROOT ?? "/work", user, env: user ? { HOME: "/home/sandbox", USER: "sandbox" } : {} })
    .listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
}

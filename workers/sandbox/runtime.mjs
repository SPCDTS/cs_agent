// 原生 Container.exec 调用的固定本地助手；不监听端口，也不接收宿主命令。
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { workspaceControl } from "./workspace.mjs";

export const OUTPUT_CAP = 64 * 1024;
const MAX_TIMEOUT_MS = 120000;
export const within = (root, file) => {
  const relative = path.relative(root, file);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
};
function fail(code) { throw new Error(code); }
async function realpathLoose(file, depth = 0) {
  if (depth > 40) fail("path_denied");
  try { return await fs.realpath(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const stat = await fs.lstat(file).catch(error => { if (error.code === "ENOENT") return; throw error; });
  if (stat?.isSymbolicLink()) return realpathLoose(path.resolve(path.dirname(file), await fs.readlink(file)), depth + 1);
  const parent = path.dirname(file);
  if (parent === file) fail("path_denied");
  return path.join(await realpathLoose(parent, depth + 1), path.basename(file));
}
export async function resolveInside(root, raw) {
  if (typeof raw !== "string" || !raw || raw.includes("\0")) fail("invalid_request");
  const absolute = path.resolve(root, raw);
  if (!within(root, absolute)) fail("path_denied");
  const real = await realpathLoose(absolute);
  if (!within(await fs.realpath(root), real)) fail("path_denied");
  return real;
}
export function tailCollector(cap = OUTPUT_CAP) {
  const chunks = [];
  let kept = 0, dropped = 0;
  return {
    push(chunk) {
      chunks.push(chunk); kept += chunk.length;
      while (chunks.length > 1 && kept - chunks[0].length >= cap) { const first = chunks.shift(); kept -= first.length; dropped += first.length; }
    },
    result() {
      let bytes = Buffer.concat(chunks), skipped = dropped;
      if (bytes.length > cap) { skipped += bytes.length - cap; bytes = bytes.subarray(bytes.length - cap); }
      let start = 0;
      if (skipped) while (start < bytes.length && start < 3 && (bytes[start] & 0xc0) === 0x80) start++;
      return { text: skipped ? `[前 ${skipped + start} 字节已省略]\n${bytes.subarray(start).toString("utf8")}` : bytes.toString("utf8"), truncated: skipped > 0 };
    },
  };
}
export function createSandboxRuntime({ root, shell = "/bin/bash", user, env = {} }) {
  const commandEnv = { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", TERM: "dumb", HOME: "/home/sandbox", USER: "sandbox", ...env };
  const own = async file => { if (user) await fs.chown(file, user.uid, user.gid); };
  const workspace = workspaceControl({ root, own });
  async function exec({ command, cwd, timeoutMs = 60000 }) {
    if (typeof command !== "string" || !command.trim() || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) fail("invalid_request");
    const directory = await resolveInside(root, cwd ?? root);
    if (!(await fs.stat(directory)).isDirectory()) fail("not_a_directory");
    return new Promise((resolve, reject) => {
      const child = spawn(shell, ["-c", command], { cwd: directory, env: commandEnv, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], ...(user ? { uid: user.uid, gid: user.gid } : {}) });
      const stdout = tailCollector(), stderr = tailCollector();
      let timedOut = false, settled = false;
      // Linux 上整个进程组一起终止，后台进程不能在快照后继续修改工作区。
      const kill = () => {
        try { if (process.platform === "win32") child.kill("SIGKILL"); else process.kill(-child.pid, "SIGKILL"); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      };
      const timer = setTimeout(() => { timedOut = true; try { kill(); } catch (error) { reject(error); } }, timeoutMs);
      const finish = code => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        try { kill(); } catch (error) { reject(error); return; }
        const out = stdout.result(), err = stderr.result();
        resolve({ stdout: out.text, stderr: err.text, code: timedOut ? null : code, timedOut, truncated: out.truncated || err.truncated });
      };
      child.stdout.on("data", chunk => stdout.push(chunk)); child.stderr.on("data", chunk => stderr.push(chunk));
      child.once("error", error => { stderr.push(Buffer.from(error.message)); finish(127); });
      child.once("close", finish);
      child.once("exit", () => {
        try { kill(); } catch (error) { reject(error); }
        setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(child.exitCode); }, 1000).unref();
      });
    });
  }
  async function restore({ stage, snapshot }) {
    // stage 由 Worker 随机生成；不允许把其它容器目录作为恢复输入或清理目标。
    if (typeof stage !== "string" || !/^\/tmp\/sandbox-import-[a-f0-9-]{36}$/.test(stage)) fail("path_denied");
    if ((await fs.realpath(stage)) !== stage) fail("path_denied");
    const { id } = await workspace.start(snapshot);
    for (const file of snapshot.files) {
      const source = await resolveInside(stage, file.path);
      await workspace.put(id, file.path, await fs.readFile(source));
    }
    return workspace.commit(id);
  }
  return { resolve: raw => resolveInside(root, raw), exec, snapshot: retainedPaths => workspace.scan(retainedPaths), restore };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runtime = createSandboxRuntime({ root: "/work", user: { uid: 1000, gid: 1000 } });
  try {
    const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const action = process.argv[2];
    let result;
    switch (action) {
      case "resolve": result = await runtime.resolve(input.path); break;
      case "exec": result = await runtime.exec(input); break;
      case "snapshot": result = await runtime.snapshot(input.retainedPaths); break;
      case "restore": result = await runtime.restore(input); break;
      default: fail("invalid_request");
    }
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    const codes = { ENOENT: "not_found", EISDIR: "is_directory", ENOTDIR: "not_a_directory", EACCES: "permission_denied", EPERM: "permission_denied" };
    process.stdout.write(JSON.stringify({ error: codes[error.code] ?? error.message, ...(error.issues ? { issues: error.issues } : {}) }));
    process.exitCode = 1;
  }
}

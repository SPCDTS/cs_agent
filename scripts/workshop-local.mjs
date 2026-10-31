// 仅管理连接进程；Workshop 任务、回执和恢复均由官方 CLI / Dispatcher 管理。
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)));
const runtime = path.join(root, "data", "workshop-bridge");
const privateDir = path.join(root, "secrets", "workshop");
const config = JSON.parse(fs.readFileSync(path.join(runtime, "local.json"), "utf8"));
const token = fs.readFileSync(path.join(privateDir, "mcp-token.txt"), "utf8").trim();
if (!token) throw new Error("Workshop MCP token is empty");
for (const file of [config.cli, config.cloudflared, path.join(runtime, "tunnel.json")]) fs.accessSync(file);
if (!Array.isArray(config.roots) || !config.roots.length) throw new Error("Workshop roots are required");
const lock = path.join(runtime, "supervisor.pid");
if (fs.existsSync(lock)) {
  const pid = Number(fs.readFileSync(lock, "utf8"));
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid supervisor PID");
  try { process.kill(pid, 0); throw new Error("Workshop supervisor is already running"); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
  fs.unlinkSync(lock);
}
fs.writeFileSync(lock, String(process.pid), { flag: "wx", encoding: "utf8" });
let stopping = false;
const children = new Set();
const timers = new Set();

function start(name, executable, args, env) {
  if (stopping) return;
  const log = path.join(runtime, name + ".log");
  if (fs.existsSync(log)) fs.renameSync(log, log + ".previous");
  const fd = fs.openSync(log, "a");
  const child = spawn(executable, args, { env, cwd: root, windowsHide: true, stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  children.add(child);
  let finished = false;
  function restart() {
    if (finished) return;
    finished = true;
    children.delete(child);
    if (stopping) return;
    const timer = setTimeout(() => { timers.delete(timer); start(name, executable, args, env); }, 5000);
    timers.add(timer);
  }
  child.once("error", error => { console.error(name + " start failed: " + error.code); restart(); });
  child.once("exit", (code, signal) => { console.error(name + " exited: " + (code ?? signal)); restart(); });
}
function stop() {
  if (stopping) return;
  stopping = true;
  for (const timer of timers) clearTimeout(timer);
  for (const child of children) child.kill();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("exit", () => {
  stop();
  try { if (fs.readFileSync(lock, "utf8") === String(process.pid)) fs.unlinkSync(lock); } catch {}
});
start("mcp", config.cli, ["mcp.serve", "--json", "--bind", "127.0.0.1:3721", "--roots-json", JSON.stringify(config.roots)],
  { ...process.env, CS2_WORKSHOP_MCP_TOKEN: token });
start("tunnel", config.cloudflared, ["tunnel", "--config", path.join(runtime, "tunnel.json"), "--no-autoupdate", "run"], process.env);

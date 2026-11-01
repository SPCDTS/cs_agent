import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { Type } from "typebox";
import { parse, validateDescriptor } from "./protocol.ts";
import { atomicJson, exists, readJson, sha256 } from "./files.ts";
import { ConfigSchema, command, descriptor, protectToken } from "./wsb.ts";
import { Connector, origin, request } from "./connector.ts";

if (process.platform !== "win32") throw new Error("此连接器需要 Windows 11 和 wsb CLI。");
const args = process.argv.slice(2), action = args.shift();
function option(name: string, fallback?: string): string | undefined {
  const at = args.indexOf("--" + name); if (at < 0) return fallback;
  const value = args[at + 1]; if (!value || value.startsWith("--")) throw new Error("missing_" + name);
  args.splice(at, 2); return value;
}
const state = path.resolve(option("state", path.join(os.homedir(), ".cs-agent-sandbox"))!);
const configFile = path.join(state, "config.json"), bundle = fileURLToPath(new URL("../dist/", import.meta.url));
if (action === "pair") {
  const base = origin(option("origin") ?? "");
  const config = { name: option("name", os.hostname())!, nodeDir: path.resolve(option("node-dir", path.dirname(process.execPath))!),
    gitDir: option("git-dir"), memoryMiB: Number(option("memory", "6144")), maxTimeoutMs: Number(option("timeout-ms", "1200000")) };
  if (args.length) throw new Error("unknown_arguments");
  const capabilities = validateDescriptor(await descriptor(config));
  if (await exists(configFile)) throw new Error("该目录已经配对；请使用独立的新 state 目录配对另一设备。");
  if (state === path.parse(state).root) throw new Error("dedicated_state_directory_required");
  await fs.mkdir(state, { recursive: true });
  const entries = await fs.readdir(state);
  if (entries.some(name => name !== "pending.json")) throw new Error("state_directory_not_empty");
  {
    const script = "$target=[Console]::In.ReadToEnd(); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; & icacls.exe $target /inheritance:r /grant:r ('*'+$sid+':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F'; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}";
    await command("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { input: state });
  }
  const pendingFile = path.join(state, "pending.json");
  const PendingSchema = Type.Object({ origin: Type.String(), tokenProtected: Type.String() });
  let tokenProtected: string;
  if (await exists(pendingFile)) {
    const pending = parse(PendingSchema, await readJson(pendingFile));
    if (pending.origin !== base) throw new Error("pending_origin_mismatch");
    tokenProtected = pending.tokenProtected;
  } else {
    tokenProtected = await protectToken(randomBytes(32).toString("hex"));
    await atomicJson(pendingFile, { origin: base, tokenProtected });
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  let pairingId: string, code: string;
  try { pairingId = (await prompt.question("配对 ID：")).trim(); code = (await prompt.question("一次性配对码：")).trim(); } finally { prompt.close(); }
  const token = await protectToken(tokenProtected, true);
  const response = parse(Type.Object({ deviceId: Type.String({ pattern: "^[a-f0-9-]{36}$" }), approval: Type.String() }), JSON.parse((await request(base, undefined, "/sandbox-devices/claim",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pairingId, code, tokenHash: sha256(token), descriptor: capabilities }) })).toString("utf8")));
  await atomicJson(configFile, parse(ConfigSchema, { ...config, origin: base, tokenProtected, deviceId: response.deviceId }));
  await fs.unlink(pendingFile);
  console.log("已提交注册，等待管理员批准。设备 ID：", response.deviceId);
} else if (action === "run" || action === "inspect") {
  if (args.length) throw new Error("unknown_arguments");
  const config = parse(ConfigSchema, await readJson(configFile));
  if (action === "inspect") console.log(JSON.stringify({ deviceId: config.deviceId, origin: config.origin, descriptor: await descriptor(config) }, null, 2));
  else {
    if (!await exists(path.join(bundle, "guest.mjs"))) throw new Error("先运行 npm --prefix runner run build。");
    const lock = path.join(state, "runner.lock");
    if (await exists(lock)) {
      const old = parse(Type.Object({ pid: Type.Integer() }), await readJson(lock));
      let alive = true; try { process.kill(old.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
      if (alive) throw new Error("runner_already_running");
      await fs.unlink(lock);
    }
    const handle = await fs.open(lock, "wx", 0o600); await handle.writeFile(JSON.stringify({ pid: process.pid }), "utf8"); await handle.close();
    const connector = new Connector(state, config, bundle);
    const stop = () => { void connector.stop().catch(error => console.error(error instanceof Error ? error.message : "stop_failed")); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try { await connector.run(); } finally { await connector.stop(); await fs.unlink(lock); }
  }
} else {
  console.log("用法：\n  npm start -- pair --origin https://你的Worker --state 专用目录 [--git-dir Git安装目录]\n  npm start -- inspect --state 专用目录\n  npm start -- run --state 专用目录");
}

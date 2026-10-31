import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Type, type Static } from "typebox";
import { parse, OutcomeSchema, validateSnapshot, mismatch, type Descriptor, type JobInput, type Outcome } from "./protocol.ts";
import { atomicJson, exists, plainFile, readJson, sha256 } from "./files.ts";
import { NpmCache } from "./cache.ts";

export const ConfigSchema = Type.Object({
  origin: Type.String({ minLength: 1 }), deviceId: Type.String({ pattern: "^[a-f0-9-]{36}$" }), tokenProtected: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1, maxLength: 80 }), nodeDir: Type.String({ minLength: 1 }), gitDir: Type.Optional(Type.String({ minLength: 1 })),
  memoryMiB: Type.Integer({ minimum: 2048, maximum: 65536 }), maxTimeoutMs: Type.Integer({ minimum: 1000, maximum: 1200000 }),
}, { additionalProperties: false });
export type Config = Static<typeof ConfigSchema>;
const InstanceSchema = Type.Object({ id: Type.String({ pattern: "^[a-f0-9-]{36}$" }), jobId: Type.String({ pattern: "^[a-f0-9-]{36}$" }) });
const StartSchema = Type.Object({ Id: Type.String({ pattern: "^[a-f0-9-]{36}$" }) });
export function command(file: string, args: string[], options: { input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(stdout);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error("host_command_timeout")); }, options.timeoutMs ?? 30000);
    child.stdout.setEncoding("utf8").on("data", (data: string) => { stdout = (stdout + data).slice(-65536); });
    child.stderr.setEncoding("utf8").on("data", (data: string) => { stderr = (stderr + data).slice(-4096); });
    child.once("error", error => finish(error));
    child.once("exit", code => finish(code === 0 ? undefined : new Error("host_command_failed:" + path.basename(file) + ":" + code + ":" + stderr.slice(0, 400))));
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input);
  });
}
export async function protectToken(value: string, decrypt = false) {
  const script = "Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[Security.Cryptography.ProtectedData]::" +
    (decrypt ? "Unprotect" : "Protect") + "($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))";
  const result = await command("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { input: decrypt ? value : Buffer.from(value, "utf8").toString("base64") });
  return decrypt ? Buffer.from(result.trim(), "base64").toString("utf8") : result.trim();
}
export async function descriptor(config: Pick<Config, "name" | "nodeDir" | "gitDir" | "memoryMiB" | "maxTimeoutMs">): Promise<Descriptor> {
  const node = (await command(path.join(config.nodeDir, "node.exe"), ["--version"])).trim();
  const npm = (await command(path.join(config.nodeDir, "node.exe"), [path.join(config.nodeDir, "node_modules/npm/bin/npm-cli.js"), "--version"])).trim();
  const tools = [{ name: "node", version: node }, { name: "npm", version: npm }];
  if (config.gitDir) tools.push({ name: "git", version: (await command(path.join(config.gitDir, "cmd/git.exe"), ["--version"])).trim() });
  if (process.arch !== "x64" && process.arch !== "arm64") throw new Error("unsupported_arch");
  return { name: config.name, provider: "windows-wsb", os: "windows", arch: process.arch, shells: ["powershell"], tools,
    taskTypes: ["shell.exec", "node.test"], memoryMiB: config.memoryMiB, maxConcurrent: 1, maxTimeoutMs: config.maxTimeoutMs,
    workspaceProtocol: "r2-source-v1", cache: { npm: true, git: false } };
}
const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const map = (host: string, guest: string, readonly: boolean) => "<MappedFolder><HostFolder>" + xml(host) + "</HostFolder><SandboxFolder>" + guest + "</SandboxFolder><ReadOnly>" + readonly + "</ReadOnly></MappedFolder>";

export class WsbBackend {
  readonly state: string;
  readonly config: Config;
  readonly bundleDir: string;
  readonly cache: NpmCache;
  constructor(state: string, config: Config, bundleDir: string) {
    this.state = path.resolve(state); this.config = config; this.bundleDir = path.resolve(bundleDir); this.cache = new NpmCache(path.join(this.state, "cache/npm"));
  }
  private stopping?: Promise<void>;
  private instanceFile() { return path.join(this.state, "instance.json"); }
  stopOwned(): Promise<void> {
    if (!this.stopping) this.stopping = this.stopInstance().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }
  private async stopInstance(): Promise<void> {
    if (!await exists(this.instanceFile())) return;
    const instance = parse(InstanceSchema, await readJson(this.instanceFile()));
    const listed: unknown = JSON.parse(await command("wsb.exe", ["list", "--raw"]));
    const list = parse(Type.Object({ WindowsSandboxEnvironments: Type.Array(Type.Object({ Id: Type.String() })) }), listed);
    if (list.WindowsSandboxEnvironments.some(row => row.Id === instance.id))
      await command("wsb.exe", ["stop", "--id", instance.id, "--raw"], { timeoutMs: 60000 });
    // stop 返回后再查一次；不能在停止结果不确定时读取 guest 输出。
    const after = parse(Type.Object({ WindowsSandboxEnvironments: Type.Array(Type.Object({ Id: Type.String() })) }), JSON.parse(await command("wsb.exe", ["list", "--raw"])));
    if (after.WindowsSandboxEnvironments.some(row => row.Id === instance.id)) throw new Error("sandbox_stop_unconfirmed");
    await fs.unlink(this.instanceFile());
  }
  async run(job: JobInput, signal: AbortSignal, progress: (text: string) => void): Promise<Outcome> {
    if (!/^[a-f0-9-]{36}$/.test(job.id)) throw new Error("invalid_job_id");
    const directory = path.join(this.state, "jobs", job.id), input = path.join(directory, "input"), output = path.join(directory, "output"), npm = path.join(directory, "npm");
    await fs.mkdir(output, { recursive: true });
    const capabilities = await descriptor(this.config);
    if (sha256(JSON.stringify(capabilities)) !== job.lease.capabilityRevision || mismatch(capabilities, job.operation.kind, job.lease.requirements).length ||
      job.operation.timeoutMs > this.config.maxTimeoutMs || job.operation.kind === "shell.exec" && job.operation.shell !== "powershell") throw new Error("capability_mismatch");
    const key = this.cache.key(job.lease.workspace, capabilities.tools.find(tool => tool.name === "node")!.version);
    const hit = await this.cache.seed(key, npm).catch(() => false);
    progress(hit ? "恢复当前工作区的 npm 下载缓存。\n" : "当前工作区没有可用 npm 下载缓存。\n");
    if (signal.aborted) return { kind: "cancelled", reason: "cancelled_before_start" };
    await this.stopOwned();
    const configuration = "<Configuration><MemoryInMB>" + this.config.memoryMiB + "</MemoryInMB><Networking>Enable</Networking>" +
      "<ClipboardRedirection>Disable</ClipboardRedirection><AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput><PrinterRedirection>Disable</PrinterRedirection><MappedFolders>" +
      map(this.config.nodeDir, "C:\\AgentTools\\node", true) + map(this.bundleDir, "C:\\AgentTools\\runner", true) +
      (this.config.gitDir ? map(this.config.gitDir, "C:\\AgentTools\\git", true) : "") +
      map(input, "C:\\AgentInput", true) + map(output, "C:\\AgentOutput", false) + map(npm, "C:\\AgentNpm", false) + "</MappedFolders></Configuration>";
    progress("正在启动 Windows Sandbox。\n");
    const requestedId = randomUUID();
    await atomicJson(this.instanceFile(), { id: requestedId, jobId: job.id });
    const started: unknown = JSON.parse(await command("wsb.exe", ["start", "--id", requestedId, "--config", configuration, "--raw"], { timeoutMs: 300000 }));
    const instance = parse(StartSchema, started);
    if (instance.Id !== requestedId) throw new Error("sandbox_identity_mismatch");
    if (signal.aborted) { await this.stopOwned(); return { kind: "cancelled", reason: "cancelled_during_start" }; }
    progress("沙箱已启动，正在执行任务。\n");
    let cancelled = false, timedOut = false;
    const stop = () => { cancelled = true; void this.stopOwned().catch(() => undefined); };
    signal.addEventListener("abort", stop, { once: true });
    const timeout = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, Math.min(job.operation.timeoutMs, job.deadline - Date.now())));
    try {
      await command("wsb.exe", ["exec", "--id", instance.Id, "--run-as", "System", "--command",
        '"C:\\AgentTools\\node\\node.exe" "C:\\AgentTools\\runner\\guest.mjs" "C:\\AgentInput\\input.json"', "--raw"],
      { timeoutMs: job.operation.timeoutMs + 65000 });
    } catch {
      // 以停止后封存的结果文件为准；CLI 失联不触发重跑。
    } finally {
      clearTimeout(timeout); signal.removeEventListener("abort", stop);
      await this.stopOwned();
    }
    if (cancelled || signal.aborted) return { kind: "cancelled", reason: timedOut ? "timeout_instance_stopped" : "cancelled_instance_stopped" };
    let outcome: Outcome;
    try {
      outcome = parse(OutcomeSchema, JSON.parse((await plainFile(output, "outcome.json", 8 * 1024 * 1024)).toString("utf8")));
      if (outcome.kind === "completed") {
        validateSnapshot(outcome.snapshot);
        for (const file of outcome.snapshot.files) {
          const bytes = await plainFile(path.join(output, "objects"), file.sha256);
          if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error("blob_corrupt");
        }
      }
    } catch { return { kind: "unknown", reason: "execution_ended_without_valid_result" }; }
    await this.cache.promote(key, npm, cache => this.verifyCache(cache)).then(() => progress("npm 下载缓存已回收。\n"), () => progress("npm 缓存校验或配额检查未通过，已放弃本次缓存。\n"));
    return outcome;
  }
  private async verifyCache(cache: string) {
    const directory = path.join(this.state, "cache-verifier"); await fs.mkdir(directory, { recursive: true });
    const user = path.join(directory, "user.npmrc"), global = path.join(directory, "global.npmrc");
    await fs.writeFile(user, "", "utf8"); await fs.writeFile(global, "", "utf8");
    await command(path.join(this.config.nodeDir, "node.exe"), [path.join(this.config.nodeDir, "node_modules/npm/bin/npm-cli.js"),
      "cache", "verify", "--cache", cache, "--userconfig", user, "--globalconfig", global, "--offline", "--ignore-scripts"],
    { cwd: directory, timeoutMs: 120000, env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, PATH: this.config.nodeDir + ";" + process.env.SystemRoot + "\\System32" } });
  }
}

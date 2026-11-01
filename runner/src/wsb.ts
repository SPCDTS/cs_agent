import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "typebox";
import { parse, IdSchema, PowerShellInputSchema, ExecResultSchema, validateDescriptor, validateToolArguments, validateOutcome, MAX_CONTROL_BYTES, mismatch, type Descriptor, type JobInput, type Outcome } from "./protocol.ts";
import { atomicJson, exists, readJson, sha256 } from "./files.ts";

export const ConfigSchema = Type.Object({
  origin: Type.String({ minLength: 1 }), deviceId: Type.String({ pattern: "^[a-f0-9-]{36}$" }), tokenProtected: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1, maxLength: 80 }), nodeDir: Type.String({ minLength: 1 }), gitDir: Type.Optional(Type.String({ minLength: 1 })),
  memoryMiB: Type.Integer({ minimum: 2048, maximum: 65536 }), maxTimeoutMs: Type.Integer({ minimum: 1000, maximum: 1200000 }),
}, { additionalProperties: false });
export type Config = Static<typeof ConfigSchema>;
const InstanceSchema = Type.Object({ id: Type.String({ pattern: "^[a-f0-9-]{36}$" }), leaseId: Type.Optional(IdSchema) });
const SessionRecordSchema = Type.Object({ leaseId: IdSchema, workspace: IdSchema, revision: Type.String(), state: Type.Union([Type.Literal("live"), Type.Literal("lost"), Type.Literal("released")]) }, { additionalProperties: false });
type SessionRecord = Static<typeof SessionRecordSchema>;
const StartSchema = Type.Object({ Id: Type.String({ pattern: "^[a-f0-9-]{36}$" }) });
const ListSchema = Type.Object({ WindowsSandboxEnvironments: Type.Array(Type.Object({ Id: Type.String() })) });
export function command(file: string, args: string[], options: { input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(stdout); };
    const timer = setTimeout(() => { child.kill(); finish(new Error("host_command_timeout")); }, options.timeoutMs ?? 30000);
    child.stdout.setEncoding("utf8").on("data", (data: string) => { stdout = (stdout + data).slice(-65536); });
    child.stderr.setEncoding("utf8").on("data", (data: string) => { stderr = (stderr + data).slice(-4096); });
    child.once("error", error => finish(error));
    child.once("close", code => finish(code === 0 ? undefined : new Error("host_command_failed:" + path.basename(file) + ":" + code + ":" + stderr.slice(0, 400) + (path.basename(file).toLowerCase() === "wsb.exe" ? ":" + stdout.slice(-1200) : ""))));
    child.stdin.on("error", () => undefined); child.stdin.end(options.input);
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
  const environment = [{ name: "node", version: node }, { name: "npm", version: npm }];
  if (config.gitDir) environment.push({ name: "git", version: (await command(path.join(config.gitDir, "cmd/git.exe"), ["--version"])).trim() });
  return validateDescriptor({ name: config.name, provider: "windows-wsb", os: "windows", arch: process.arch, workspaceRoot: "C:\\AgentWork",
    instructions: "此沙箱提供 powershell 工具，在 Windows Sandbox 内执行命令，默认目录 C:\\AgentWork，cwd 必须是 guest 内的 Windows 路径。" +
      "每次调用启动独立 PowerShell 进程，变量、环境修改和当前目录不跨调用保留；同一租约复用 VM，文件、.git、node_modules 与 npm 缓存保留在 guest。" +
      "源码可用 git clone 或文件命令准备，不与其他沙箱或 R2 自动同步。运行 npm 请用 npm.cmd；外部程序失败后应检查 $LASTEXITCODE 并显式退出。" +
      "完成后检查结果 code、stdout、stderr、timedOut；code=0 才表示进程成功。释放、取消、超时、连接器退出或实例丢失会销毁 guest，请提前保存需要保留的修改。",
    persistence: "同一租约内保留文件和缓存；释放或实例丢失后丢弃，不做 R2 源码同步。",
    tools: [{ name: "powershell", description: "在当前租约的 Windows Sandbox 工作区 C:\\AgentWork 执行 PowerShell；正常完成保留文件、.git 与 node_modules。cwd 为 guest 路径，默认 C:\\AgentWork。", inputSchema: PowerShellInputSchema }],
    environment, memoryMiB: config.memoryMiB, maxConcurrent: 1, maxTimeoutMs: config.maxTimeoutMs, workspaceProtocol: "registered-tools-v2" });
}
const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const map = (host: string, guest: string, readonly: boolean) => "<MappedFolder><HostFolder>" + xml(host) + "</HostFolder><SandboxFolder>" + guest + "</SandboxFolder><ReadOnly>" + readonly + "</ReadOnly></MappedFolder>";
type Session = { id: string; record: SessionRecord; input: string; result: FileHandle };

export class WsbBackend {
  readonly state: string;
  readonly config: Config;
  readonly bundleDir: string;
  private readonly host: typeof command;
  private readonly capabilities: () => Promise<Descriptor>;
  private session?: Session;
  private stopping?: Promise<void>;
  private recovered?: Promise<void>;
  private busy = false;
  constructor(state: string, config: Config, bundleDir: string, adapters?: { command?: typeof command; capabilities?: () => Promise<Descriptor> }) {
    this.state = path.resolve(state); this.config = config; this.bundleDir = path.resolve(bundleDir);
    this.host = adapters?.command ?? command; this.capabilities = adapters?.capabilities ?? (() => descriptor(config));
  }
  private instanceFile() { return path.join(this.state, "instance.json"); }
  private leaseFile(id: string) { return path.join(this.state, "leases", sha256(id) + ".json"); }
  private async record(id: string): Promise<SessionRecord | undefined> { return await exists(this.leaseFile(id)) ? parse(SessionRecordSchema, await readJson(this.leaseFile(id))) : undefined; }
  private async lost(id: string) { const record = await this.record(id); if (record && record.state !== "released") await atomicJson(this.leaseFile(id), { ...record, state: "lost" }); }
  stopOwned(): Promise<void> {
    if (!this.stopping) this.stopping = this.stopInstance().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }
  private async stopInstance(): Promise<void> {
    if (!await exists(this.instanceFile())) { await this.session?.result.close(); this.session = undefined; return; }
    const instance = parse(InstanceSchema, await readJson(this.instanceFile()));
    if (instance.leaseId) await this.lost(instance.leaseId);
    const listed = parse(ListSchema, JSON.parse(await this.host("wsb.exe", ["list", "--raw"])));
    if (listed.WindowsSandboxEnvironments.some(row => row.Id === instance.id)) await this.host("wsb.exe", ["stop", "--id", instance.id, "--raw"], { timeoutMs: 60000 });
    const after = parse(ListSchema, JSON.parse(await this.host("wsb.exe", ["list", "--raw"])));
    if (after.WindowsSandboxEnvironments.some(row => row.Id === instance.id)) throw new Error("sandbox_stop_unconfirmed");
    await this.session?.result.close(); this.session = undefined;
    await fs.unlink(this.instanceFile());
  }
  async release(leaseId: string): Promise<void> {
    parse(IdSchema, leaseId);
    if (this.busy) throw new Error("local_slot_busy");
    if (await exists(this.instanceFile())) {
      const instance = parse(InstanceSchema, await readJson(this.instanceFile()));
      if (instance.leaseId !== leaseId) throw new Error("lease_mismatch");
      await this.stopOwned();
    }
    const record = await this.record(leaseId);
    if (record) await atomicJson(this.leaseFile(leaseId), { ...record, state: "released" });
  }
  private async acquire(job: JobInput, progress: (text: string) => void): Promise<Session> {
    const record = await this.record(job.lease.id);
    if (record && (record.state !== "live" || record.workspace !== job.lease.workspace || record.revision !== job.lease.capabilityRevision)) throw new Error("session_lost");
    if (this.session) {
      if (this.session.record.leaseId !== job.lease.id) throw new Error("lease_mismatch");
      const listed = parse(ListSchema, JSON.parse(await this.host("wsb.exe", ["list", "--raw"])));
      if (!listed.WindowsSandboxEnvironments.some(row => row.Id === this.session?.id)) { await this.stopOwned(); throw new Error("session_lost"); }
      return this.session;
    }
    if (record) { await this.lost(job.lease.id); throw new Error("session_lost"); }
    const root = path.join(this.state, "sessions", sha256(job.lease.id)), input = path.join(root, "input"), output = path.join(root, "output");
    await fs.mkdir(input, { recursive: true }); await fs.mkdir(output, { recursive: true });
    await atomicJson(path.join(input, "input.json"), job);
    // 先打开结果句柄再映射目录；VM 运行时绝不重新解析 guest 可写路径。
    const result = await fs.open(path.join(output, "outcome.json"), "wx+", 0o600), id = randomUUID();
    const live: SessionRecord = { leaseId: job.lease.id, workspace: job.lease.workspace, revision: job.lease.capabilityRevision, state: "live" };
    this.session = { id, record: live, input, result };
    await atomicJson(this.leaseFile(job.lease.id), live);
    await atomicJson(this.instanceFile(), { id, leaseId: job.lease.id });
    const configuration = "<Configuration><MemoryInMB>" + this.config.memoryMiB + "</MemoryInMB><Networking>Enable</Networking>" +
      "<ClipboardRedirection>Disable</ClipboardRedirection><AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput><PrinterRedirection>Disable</PrinterRedirection><MappedFolders>" +
      map(this.config.nodeDir, "C:\\AgentTools\\node", true) + map(this.bundleDir, "C:\\AgentTools\\runner", true) +
      (this.config.gitDir ? map(this.config.gitDir, "C:\\AgentTools\\git", true) : "") + map(input, "C:\\AgentInput", true) + map(output, "C:\\AgentOutput", false) + "</MappedFolders></Configuration>";
    progress("正在启动当前租约的 Windows Sandbox。\n");
    const started = parse(StartSchema, JSON.parse(await this.host("wsb.exe", ["start", "--id", id, "--config", configuration, "--raw"], { timeoutMs: 300000 })));
    if (started.Id !== id) throw new Error("sandbox_identity_mismatch");
    return this.session;
  }
  async run(job: JobInput, signal: AbortSignal, progress: (text: string) => void): Promise<Outcome> {
    if (this.busy) return { kind: "failed", error: "local_slot_busy" };
    this.busy = true;
    let timer: NodeJS.Timeout | undefined, abort: (() => void) | undefined, stop: Promise<void> | undefined, timedOut = false;
    try {
      this.recovered ??= this.stopOwned(); await this.recovered;
      const capabilities = validateDescriptor(await this.capabilities());
      if (sha256(JSON.stringify(capabilities)) !== job.lease.capabilityRevision || mismatch(capabilities, job.lease.requirements).length || job.timeoutMs > capabilities.maxTimeoutMs) return { kind: "failed", error: "capability_mismatch" };
      validateToolArguments(capabilities, job.tool, job.arguments);
      if (job.tool !== "powershell") return { kind: "failed", error: "tool_not_registered" };
      if (signal.aborted || Date.now() >= job.deadline) {
        await this.stopOwned(); await atomicJson(this.leaseFile(job.lease.id), { leaseId: job.lease.id, workspace: job.lease.workspace, revision: job.lease.capabilityRevision, state: "lost" });
        return { kind: "cancelled", reason: "cancelled_before_execution", sessionLost: true };
      }
      const session = await this.acquire(job, progress);
      await session.result.truncate(0);
      // WSB 的只读映射会锁住 rename；输入仅由宿主串行写，写完才启动固定 launcher。
      await fs.writeFile(path.join(session.input, "input.json"), JSON.stringify(job), "utf8");
      abort = () => { stop ??= this.stopOwned(); void stop.catch(() => undefined); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted || Date.now() >= job.deadline) { abort(); await stop; return { kind: "cancelled", reason: "cancelled_during_start", sessionLost: true }; }
      timer = setTimeout(() => { timedOut = true; abort?.(); }, Math.max(1, Math.min(job.timeoutMs, job.deadline - Date.now())));
      progress("沙箱会话就绪，正在执行 PowerShell。\n");
      await this.host("wsb.exe", ["exec", "--id", session.id, "--run-as", "System", "--command", '"C:\\AgentTools\\node\\node.exe" "C:\\AgentTools\\runner\\guest.mjs" "C:\\AgentInput\\input.json"', "--raw"], { timeoutMs: job.timeoutMs + 65000 });
      if (timer) clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (stop) { await stop; return { kind: "cancelled", reason: timedOut ? "timeout_instance_stopped" : "cancelled_instance_stopped", sessionLost: true }; }
      const stat = await session.result.stat();
      if (stat.size < 1 || stat.size > MAX_CONTROL_BYTES) throw new Error("invalid_result");
      const bytes = Buffer.alloc(stat.size), read = await session.result.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead !== bytes.length) throw new Error("invalid_result");
      const outcome = validateOutcome(JSON.parse(bytes.toString("utf8")));
      if (outcome.kind !== "completed") throw new Error("execution_ended_without_result");
      parse(ExecResultSchema, outcome.result);
      return { kind: "completed", result: outcome.result };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "sandbox_execution_unconfirmed";
      if (reason === "session_lost" || reason === "lease_mismatch") return { kind: "failed", error: reason, sessionLost: true };
      if (!signal.aborted && !timedOut) console.error("WSB 执行失败：", reason);
      await (stop ?? this.stopOwned());
      if (signal.aborted || timedOut) return { kind: "cancelled", reason: timedOut ? "timeout_instance_stopped" : "cancelled_instance_stopped", sessionLost: true };
      return { kind: "unknown", reason: "sandbox_execution_unconfirmed", sessionLost: true };
    } finally { if (timer) clearTimeout(timer); if (abort) signal.removeEventListener("abort", abort); this.busy = false; }
  }
}

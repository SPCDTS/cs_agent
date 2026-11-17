import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { StringDecoder } from 'node:string_decoder';
import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';

const strict = { additionalProperties: false };
export const RequestId = Type.String({ pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' });
export const ShellRequest = Type.Object({
  requestId: RequestId,
  command: Type.String({ minLength: 1, maxLength: 65536 }),
  cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 1200000 })),
  waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 5000 })),
}, strict);
export const ShellSpec = Type.Object({ kind: Type.Union([Type.Literal('powershell'), Type.Literal('bash'), Type.Literal('zsh')]), command: Type.String({ minLength: 1 }) }, strict);
export type Shell = Static<typeof ShellSpec>;
export const ShellReceipt = Type.Object({
  requestId: RequestId,
  state: Type.Union([Type.Literal('running'), Type.Literal('succeeded'), Type.Literal('failed'), Type.Literal('cancelled'), Type.Literal('timed_out'), Type.Literal('unknown')]),
  stdout: Type.String(), stderr: Type.String(), truncated: Type.Boolean(),
  exitCode: Type.Union([Type.Integer(), Type.Null()]),
  startedAt: Type.Number(), finishedAt: Type.Union([Type.Number(), Type.Null()]),
  details: Type.Union([Type.Literal('retained'), Type.Literal('archived')]),
}, strict);
export type Receipt = Static<typeof ShellReceipt>;
type Running = { child: ChildProcess; done: Promise<void>; stop?: 'cancelled' | 'timed_out'; receipt: Receipt };
type ShellOptions = { stateDir: string; workdir: string; shell: Shell; outputLimit?: number; maxRunning?: number };

export function defaultShell(): Shell {
  if (process.platform === 'win32') return { kind: 'powershell', command: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') };
  return process.platform === 'darwin' ? { kind: 'zsh', command: '/bin/zsh' } : { kind: 'bash', command: '/bin/bash' };
}

function shellArgs(shell: Shell, file: string): string[] {
  if (shell.kind === 'powershell') {
    return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file];
  }
  return shell.kind === 'zsh' ? ['-f'] : ['--noprofile', '--norc'];
}

/** 本机命令收据跨重启去重；崩溃后的活跃命令只标记 unknown，不按 PID 猜测或重放。 */
export class DeviceShell {
  readonly options: ShellOptions;
  private readonly db: DatabaseSync;
  private readonly running = new Map<string, Running>();
  private closed = false;
  constructor(options: ShellOptions) {
    this.options = options;
    mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
    mkdirSync(options.workdir, { recursive: true });
    this.db = new DatabaseSync(path.join(options.stateDir, 'shell.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS shell_jobs(scope TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(scope,request_id));
      UPDATE shell_jobs SET receipt=json_set(receipt,'$.state','unknown','$.finishedAt',${Date.now()}) WHERE json_extract(receipt,'$.state')='running';`);
  }
  info() {
    return { platform: process.platform, arch: process.arch, hostname: os.hostname(), user: os.userInfo().username,
      shell: this.options.shell.kind, workdir: this.options.workdir, persistent: true,
      instructions: '本机可信持久环境；工作目录、Git、依赖与文件在设备上保留。cwd 只是默认目录，不是权限隔离边界。命令以本机账户权限运行。每次调用启动新 Shell，cd 和环境变量不跨调用保留；显式指定 cwd。所有会话共享文件。重试使用同一 requestId 和参数；unknown 先核查实际状态，禁止盲目重放。' };
  }
  private key(scope: string, requestId: string) { return JSON.stringify([scope, requestId]); }
  private save(scope: string, receipt: Receipt) { this.db.prepare('UPDATE shell_jobs SET receipt=? WHERE scope=? AND request_id=?').run(JSON.stringify(receipt), scope, receipt.requestId); }
  get(scope: string, requestId: string): Receipt {
    const row = this.db.prepare('SELECT receipt FROM shell_jobs WHERE scope=? AND request_id=?').get(scope, requestId);
    if (!row || typeof row.receipt !== 'string') throw new Error('job_not_found');
    const value: unknown = JSON.parse(row.receipt);
    if (!Check(ShellReceipt, value)) throw new Error('invalid_job_receipt');
    return value;
  }
  async exec(scope: string, input: Static<typeof ShellRequest>): Promise<Receipt> {
    if (this.closed) throw new Error('service_stopping');
    const cwd = path.resolve(this.options.workdir, input.cwd ?? '.'), timeoutMs = input.timeoutMs ?? 120000;
    if (cwd.includes('\0')) throw new Error('invalid_workdir');
    const fingerprint = createHash('sha256').update(JSON.stringify([this.options.shell, input.command, cwd, timeoutMs])).digest('hex');
    const old = this.db.prepare('SELECT fingerprint FROM shell_jobs WHERE scope=? AND request_id=?').get(scope, input.requestId);
    if (old) {
      if (old.fingerprint !== fingerprint) throw new Error('request_id_conflict');
      return this.get(scope, input.requestId);
    }
    if (this.running.size >= (this.options.maxRunning ?? 4)) throw new Error('device_busy');
    // 归档输出但保留 requestId 和指纹，避免重启或历史重试重新执行。
    this.db.prepare("UPDATE shell_jobs SET receipt=json_set(receipt,'$.stdout','','$.stderr','','$.details','archived') WHERE json_extract(receipt,'$.finishedAt')<? AND json_extract(receipt,'$.details')='retained'").run(Date.now() - 7 * 86400000);
    if (Number(this.db.prepare('SELECT COUNT(*) AS n FROM shell_jobs').get()?.n) >= 100000) throw new Error('device_ledger_full');
    const receipt: Receipt = { requestId: input.requestId, state: 'running', stdout: '', stderr: '', truncated: false, exitCode: null, startedAt: Date.now(), finishedAt: null, details: 'retained' };
    const scriptFile = path.join(this.options.stateDir, 'command-' + createHash('sha256').update(this.key(scope, input.requestId)).digest('hex') + '.ps1');
    if (this.options.shell.kind === 'powershell') {
      const setup = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding;\n";
      // PowerShell 5.1 需要 BOM 才能可靠读取中文；文件避免 Windows 命令行长度限制。
      writeFileSync(scriptFile, '\uFEFF' + setup + input.command + '\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }\n', { encoding: 'utf8', mode: 0o600 });
    }
    this.db.prepare('INSERT INTO shell_jobs VALUES(?,?,?,?)').run(scope, input.requestId, fingerprint, JSON.stringify(receipt));
    const child = spawn(this.options.shell.command, shellArgs(this.options.shell, scriptFile), {
      cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      // 接入凭据不能通过继承环境变量落进 agent 执行的命令。
      env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(TUNNEL_TOKEN|CS_AGENT_DEVICE_)/i.test(name))),
    });
    let resolveDone = () => {};
    const job: Running = { child, receipt, done: new Promise<void>(resolve => { resolveDone = resolve; }) };
    const key = this.key(scope, input.requestId);
    this.running.set(key, job);
    let used = 0;
    const append = (stream: 'stdout' | 'stderr', text: string) => {
      const bytes = Buffer.from(text), remaining = Math.max(0, (this.options.outputLimit ?? 256 * 1024) - used);
      if (remaining === 0 && receipt.truncated) return;
      if (bytes.length > remaining) receipt.truncated = true;
      const accepted = bytes.subarray(0, remaining); used += accepted.length;
      receipt[stream] += new StringDecoder('utf8').write(accepted);
      this.save(scope, receipt);
    };
    child.stdout.setEncoding('utf8').on('data', (text: string) => append('stdout', text));
    child.stderr.setEncoding('utf8').on('data', (text: string) => append('stderr', text));
    child.stdin.on('error', () => {});
    child.stdin.end(this.options.shell.kind === 'powershell' ? undefined : input.command + '\n');
    child.once('error', () => { receipt.stderr = 'shell_start_failed'; });
    const timer = setTimeout(() => { job.stop = 'timed_out'; void this.stop(job); }, timeoutMs);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (this.options.shell.kind === 'powershell') { try { unlinkSync(scriptFile); } catch {} }
      receipt.state = job.stop ?? (code === 0 ? 'succeeded' : signal ? 'unknown' : 'failed');
      receipt.exitCode = code; receipt.finishedAt = Date.now();
      this.save(scope, receipt); this.running.delete(key); resolveDone();
    });
    let wait: NodeJS.Timeout | undefined;
    await Promise.race([job.done, new Promise<void>(resolve => { wait = setTimeout(resolve, input.waitMs ?? 1000); })]);
    clearTimeout(wait);
    return this.get(scope, input.requestId);
  }
  private async stop(job: Running) {
    const pid = job.child.pid;
    if (!pid) return;
    if (process.platform === 'win32') {
      await new Promise<void>(resolve => {
        const taskkill = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        taskkill.once('error', () => resolve()); taskkill.once('close', () => resolve());
      });
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* 进程已经退出。 */ }
    }
  }
  async cancel(scope: string, requestId: string) {
    const receipt = this.get(scope, requestId), job = this.running.get(this.key(scope, requestId));
    if (!job) return receipt;
    job.stop ??= 'cancelled'; await this.stop(job);
    return this.get(scope, requestId);
  }
  async close() {
    this.closed = true;
    await Promise.all([...this.running.values()].map(async job => { job.stop ??= 'cancelled'; await this.stop(job); await job.done; }));
    this.db.close();
  }
}

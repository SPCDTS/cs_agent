import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { sha256 } from './files.ts';
import type { Backend, Command, Execution, ExecutionStatus, Subject, Target } from './domain.ts';
type Phase = 'queued' | 'dispatching' | 'active' | 'cancelling' | 'terminal';
interface JobRow { id: string; principal: string; scope: string; target: string; request_id: string; fingerprint: string; execution: string; phase: Phase; status: string; created: number }
interface SessionRow { id: string; principal: string; scope: string; target: string; state: 'open' | 'closing' | 'closed'; expires: number; idle_until: number; idle_ms: number }
export interface Receipt {
  requestId: string; jobId: string; sessionId?: string; deadline: number;
  state: 'queued' | 'running' | 'cancelling' | ExecutionStatus['state'];
  result?: { exitCode: number; stdout: string; stderr: string; truncated: boolean }; error?: string;
}
const active = (phase: Phase) => phase !== 'terminal';
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + stable(v)).join(',') + '}';
  return JSON.stringify(value);
};
/** SQLite 是主账本；原生后端只写执行证据。请求去重记录不自动删除。 */
export class Jobs {
  private db: DatabaseSync;
  private file: string;
  private timer?: NodeJS.Timeout;
  private pending?: Promise<void>;
  private stopped = false;
  private backends: Record<Target['kind'], Backend>;
  private now: () => number;
  constructor(stateDir: string, backends: Record<Target['kind'], Backend>, now: () => number = Date.now) {
    this.backends = backends; this.now = now;
    mkdirSync(stateDir, { recursive: true }); this.file = path.join(stateDir, 'jobs.sqlite');
    this.db = new DatabaseSync(this.file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS targets (id TEXT PRIMARY KEY, identity TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, principal TEXT NOT NULL, scope TEXT NOT NULL, target TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, execution TEXT NOT NULL, phase TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL, UNIQUE(principal,scope,target,request_id));
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, principal TEXT NOT NULL, scope TEXT NOT NULL, target TEXT NOT NULL, state TEXT NOT NULL, expires INTEGER NOT NULL, idle_until INTEGER NOT NULL, idle_ms INTEGER NOT NULL);`);
    // dispatching 表示进程可能已接到命令；恢复时只能 inspect。
    this.db.exec("UPDATE jobs SET phase='active' WHERE phase='dispatching'");
  }
  bindTargets(targets: Target[]) {
    for (const target of targets) {
      const identity = stable(target.kind === 'hyperv' ? { kind: target.kind, vmId: target.vmId.toLowerCase() } : { kind: target.kind });
      const old = this.db.prepare('SELECT identity FROM targets WHERE id=?').get(target.id);
      if (old && old.identity !== identity) throw new Error('target_id_reused_for_different_environment');
      this.db.prepare('INSERT OR IGNORE INTO targets(id,identity) VALUES(?,?)').run(target.id, identity);
    }
    // 取消配置已移除目标的未派发命令；已执行的保留查询/清理证据。
    for (const row of this.rows()) if (row.phase === 'queued' && !targets.some(t => t.id === row.target)) this.finish(row, { state: 'cancelled' });
  }
  start(intervalMs = 250) { this.timer ??= setInterval(() => { void this.tick(); }, intervalMs); this.timer.unref(); void this.tick(); }
  async shutdown() {
    if (this.stopped) return;
    this.stopped = true; if (this.timer) clearInterval(this.timer);
    await this.pending; this.db.close();
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private find(subject: Subject, target: Target, requestId: string): JobRow | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE principal=? AND scope=? AND target=? AND request_id=?').get(subject.principal, subject.scope, target.id, requestId) as JobRow | undefined;
  }
  private rows(): JobRow[] { return this.db.prepare("SELECT * FROM jobs WHERE phase != 'terminal' ORDER BY created,rowid").all() as unknown as JobRow[]; }
  private execution(row: JobRow): Execution { return JSON.parse(row.execution) as Execution; }
  private receipt(row: JobRow): Receipt {
    const execution = this.execution(row), status = JSON.parse(row.status) as ExecutionStatus;
    return { requestId: row.request_id, jobId: row.id, ...(execution.sessionId ? { sessionId: execution.sessionId } : {}), deadline: execution.deadline,
      ...(row.phase === 'queued' ? { state: 'queued' as const } : row.phase === 'cancelling' ? { state: 'cancelling' as const } : status) };
  }
  submit(subject: Subject, target: Target, requestId: string, command: Command, sessionId?: string): Receipt {
    if (this.stopped) throw new Error('service_stopping');
    const fingerprint = sha256(stable({ command, sessionId: sessionId ?? null }));
    return this.transaction(() => {
      const prior = this.find(subject, target, requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error('request_id_conflict');
        return this.receipt(prior);
      }
      const count = this.db.prepare('SELECT COUNT(*) AS count FROM jobs').get()!;
      if (Number(count.count) >= 4096 || statSync(this.file).size > 128 * 1024 * 1024) throw new Error('job_ledger_full');
      let deadline = this.now() + command.timeoutMs;
      if (target.kind === 'wsb') {
        if (sessionId) {
          const session = this.session(subject, target, sessionId);
          if (!session || session.state !== 'open' || session.expires <= this.now() || (session.idle_until <= this.now() && !this.rows().some(row => this.execution(row).sessionId === sessionId))) throw new Error('session_unavailable');
          deadline = Math.min(deadline, session.expires);
          this.db.prepare('UPDATE sessions SET idle_until=? WHERE id=?').run(Math.min(session.expires, this.now() + target.idleTimeoutMs), sessionId);
        } else {
          if (this.db.prepare("SELECT id FROM sessions WHERE state != 'closed'").get()) throw new Error('wsb_busy');
          sessionId = randomUUID(); deadline = Math.min(deadline, this.now() + target.maxLifetimeMs);
          this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?)').run(sessionId, subject.principal, subject.scope, target.id, 'open', this.now() + target.maxLifetimeMs, this.now() + target.idleTimeoutMs, target.idleTimeoutMs);
        }
      } else if (sessionId) throw new Error('session_not_supported');
      const execution: Execution = { id: randomUUID(), requestId, subject, target, command, ...(sessionId ? { sessionId } : {}), deadline };
      this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?)').run(execution.id, subject.principal, subject.scope, target.id, requestId, fingerprint, JSON.stringify(execution), 'queued', JSON.stringify({ state: 'running' }), this.now());
      return this.receipt(this.find(subject, target, requestId)!);
    });
  }
  get(subject: Subject, target: Target, requestId: string): Receipt {
    const row = this.find(subject, target, requestId); if (!row) throw new Error('job_not_found'); return this.receipt(row);
  }
  cancel(subject: Subject, target: Target, requestId: string): Receipt {
    const row = this.find(subject, target, requestId); if (!row) throw new Error('job_not_found');
    if (row.phase === 'queued') this.finish(row, { state: 'cancelled' });
    else if (active(row.phase)) {
      const execution = this.execution(row);
      if (execution.sessionId) this.beginClose(execution.sessionId);
      else this.db.prepare("UPDATE jobs SET phase='cancelling' WHERE id=?").run(row.id);
    }
    return this.get(subject, target, requestId);
  }
  close(subject: Subject, target: Target, sessionId: string): { sessionId: string; state: 'closing' | 'closed' } {
    const session = this.session(subject, target, sessionId); if (!session) throw new Error('session_not_found');
    if (session.state !== 'closed') this.beginClose(sessionId);
    return { sessionId, state: session.state === 'closed' ? 'closed' : 'closing' };
  }
  private session(subject: Subject, target: Target, id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id=? AND principal=? AND scope=? AND target=?').get(id, subject.principal, subject.scope, target.id) as SessionRow | undefined;
  }
  private beginClose(id: string) {
    this.db.prepare("UPDATE sessions SET state='closing' WHERE id=? AND state!='closed'").run(id);
    for (const row of this.rows()) if (this.execution(row).sessionId === id) {
      if (row.phase === 'queued') this.finish(row, { state: 'cancelled' });
      else this.db.prepare("UPDATE jobs SET phase='cancelling' WHERE id=?").run(row.id);
    }
  }
  private finish(row: JobRow, status: ExecutionStatus) {
    if (status.state === 'succeeded') {
      const bound = (value: string) => Buffer.byteLength(value, 'utf8') <= 48000 ? value : Buffer.from(value, 'utf8').subarray(0, 47996).toString('utf8');
      const stdout = bound(status.result.stdout), stderr = bound(status.result.stderr);
      status = { state: 'succeeded', result: { ...status.result, stdout, stderr, truncated: status.result.truncated || stdout !== status.result.stdout || stderr !== status.result.stderr } };
    }
    const phase: Phase = status.state === 'running' || status.state === 'unknown' ? 'active' : 'terminal';
    // 取消期间的 inspect 不能抹掉取消意图。
    this.db.prepare("UPDATE jobs SET phase=CASE WHEN phase='cancelling' AND ?='active' THEN 'cancelling' ELSE ? END,status=? WHERE id=?").run(phase, phase, JSON.stringify(status), row.id);
    const execution = this.execution(row);
    if (execution.sessionId && phase === 'terminal') this.db.prepare('UPDATE sessions SET idle_until=MIN(expires,?) WHERE id=?').run(this.now() + (execution.target.kind === 'wsb' ? execution.target.idleTimeoutMs : 0), execution.sessionId);
  }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.advance().catch(() => { /* 下次轮询重查证据，绝不重新派发。 */ }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async advance() {
    const sessions = this.db.prepare("SELECT * FROM sessions WHERE state!='closed'").all() as unknown as SessionRow[];
    for (const session of sessions) {
      const hasWork = this.rows().some(row => this.execution(row).sessionId === session.id);
      if (session.expires <= this.now() || (!hasWork && session.idle_until <= this.now())) this.beginClose(session.id);
    }
    const lanes = new Set<string>();
    const steps: Promise<void>[] = [];
    for (const row of this.rows()) {
      const execution = this.execution(row), lane = execution.sessionId ?? execution.target.id;
      if (lanes.has(lane)) continue;
      lanes.add(lane); steps.push(this.advanceJob(row, execution));
    }
    await Promise.allSettled(steps);
    for (const session of this.db.prepare("SELECT * FROM sessions WHERE state='closing'").all() as unknown as SessionRow[]) {
      try {
        if (await this.backends.wsb.closeSession?.(session.id)) {
          for (const row of this.rows()) if (this.execution(row).sessionId === session.id) {
            const execution = this.execution(row);
            // 销毁确认与取消请求之间可能已自然完成，优先保留原生终结收据。
            this.finish(row, await this.backends.wsb.stop(execution));
          }
          this.db.prepare("UPDATE sessions SET state='closed' WHERE id=?").run(session.id);
        }
      } catch { /* 未确认销毁时继续占用 WSB 槽位。 */ }
    }
  }
  private async advanceJob(row: JobRow, execution: Execution) {
    const backend = this.backends[execution.target.kind];
    if (execution.deadline <= this.now()) {
      if (row.phase === 'queued') { this.finish(row, { state: 'cancelled' }); return; }
      if (execution.sessionId) this.beginClose(execution.sessionId);
      this.db.prepare("UPDATE jobs SET phase='cancelling' WHERE id=?").run(row.id); row.phase = 'cancelling';
    }
    if (row.phase === 'cancelling') {
      try { this.finish(row, await backend.stop(execution)); }
      catch { this.finish(row, { state: 'unknown', error: 'stop_not_confirmed' }); }
      return;
    }
    if (row.phase === 'queued') {
      this.db.prepare("UPDATE jobs SET phase='dispatching' WHERE id=?").run(row.id);
      try { await backend.dispatch(execution); }
      catch { this.finish(row, { state: 'unknown', error: 'dispatch_outcome_unknown' }); return; }
      this.db.prepare("UPDATE jobs SET phase='active' WHERE id=? AND phase='dispatching'").run(row.id);
    }
    try { this.finish(row, await backend.inspect(execution)); }
    catch { this.finish(row, { state: 'unknown', error: 'inspect_unavailable' }); }
  }
}

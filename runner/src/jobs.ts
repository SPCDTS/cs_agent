import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { Check } from 'typebox/value';
import { LastErrorSchema, LedgerCountsSchema, LedgerStorageSchema, type EnvironmentStatus, type Readiness } from './environment-status.ts';
import { JobDetails, COMPLETED_DETAILS_RETENTION_MS } from './job-details.ts';
import path from 'node:path';
import { sha256 } from './files.ts';
import type { Backend, Command, Execution, ExecutionStatus, Subject, Target } from './domain.ts';
type Phase = 'queued' | 'dispatching' | 'active' | 'cancelling' | 'terminal';
interface JobRow { id: string; principal: string; scope: string; target: string; request_id: string; fingerprint: string; execution: string; phase: Phase; status: string; created: number }
interface SessionRow { id: string; principal: string; scope: string; target: string; state: 'open' | 'closing' | 'closed'; expires: number; idle_until: number; idle_ms: number }
export interface Receipt {
  requestId: string; jobId: string; sessionId?: string; deadline: number;
  state: 'queued' | 'running' | 'cancelling' | ExecutionStatus['state'];
  details: 'retained' | 'archived';
  result?: { exitCode: number; stdout: string; stderr: string; truncated: boolean };
  resultSummary?: { exitCode: number; truncated: boolean }; error?: string;
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
  private readonly databasePath: string;
  private readonly details: JobDetails;
  private nextArchive = 0;
  private timer?: NodeJS.Timeout;
  private pending?: Promise<void>;
  private stopped = false;
  private backends: Record<Target['kind'], Backend>;
  private now: () => number;
  constructor(stateDir: string, backends: Record<Target['kind'], Backend>, now: () => number = Date.now) {
    this.backends = backends; this.now = now;
    mkdirSync(stateDir, { recursive: true });
    this.databasePath = path.join(stateDir, 'jobs.sqlite');
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS targets (id TEXT PRIMARY KEY, identity TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, principal TEXT NOT NULL, scope TEXT NOT NULL, target TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, execution TEXT NOT NULL, phase TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL, UNIQUE(principal,scope,target,request_id));
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, principal TEXT NOT NULL, scope TEXT NOT NULL, target TEXT NOT NULL, state TEXT NOT NULL, expires INTEGER NOT NULL, idle_until INTEGER NOT NULL, idle_ms INTEGER NOT NULL);`);
    this.details = new JobDetails(this.db, this.now());
    this.db.exec("CREATE INDEX IF NOT EXISTS jobs_errors_created ON jobs(principal,scope,target,created DESC) WHERE json_extract(status,'$.state') IN ('unknown','failed')");
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
  private execution(row: JobRow): Execution { return this.details.execution(row.id); }
  private receipt(row: JobRow): Receipt {
    const metadata = this.details.metadata(row.execution), { details, status } = this.details.read(row.id, row.status);
    return { requestId: row.request_id, jobId: row.id, ...metadata, details,
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
      const { command: _command, ...metadata } = execution;
      this.db.prepare('INSERT INTO jobs(id,principal,scope,target,request_id,fingerprint,execution,phase,status,created) VALUES(?,?,?,?,?,?,?,?,?,?)').run(execution.id, subject.principal, subject.scope, target.id, requestId, fingerprint, JSON.stringify(metadata), 'queued', JSON.stringify({ state: 'running' }), this.now());
      this.details.insert(execution);
      return this.receipt(this.find(subject, target, requestId)!);
    });
  }
  get(subject: Subject, target: Target, requestId: string): Receipt {
    const row = this.find(subject, target, requestId); if (!row) throw new Error('job_not_found'); return this.receipt(row);
  }
  private ledger(subject: Subject, target: Target): EnvironmentStatus['ledger'] {
    const counts = this.db.prepare('SELECT COUNT(*) AS jobs,COUNT(p.id) AS retainedPayloads FROM jobs j LEFT JOIN job_payloads p ON p.id=j.id WHERE j.principal=? AND j.scope=? AND j.target=?')
      .get(subject.principal, subject.scope, target.id);
    const storage = this.db.prepare('SELECT page_count*page_size AS allocatedBytes,freelist_count*page_size AS reusableBytes FROM pragma_page_count(),pragma_page_size(),pragma_freelist_count()').get();
    if (!Check(LedgerCountsSchema, counts) || !Check(LedgerStorageSchema, storage)) throw new Error('ledger_metrics_invalid');
    return { ...counts, ...storage, databaseBytes: statSync(this.databasePath).size, walBytes: statSync(this.databasePath + '-wal', { throwIfNoEntry: false })?.size ?? 0 };
  }
  async status(subject: Subject, target: Target): Promise<EnvironmentStatus> {
    let readiness: Readiness;
    try { readiness = await this.backends[target.kind].probe?.(target) ?? { state: 'unknown', error: 'probe_not_supported' }; }
    catch { readiness = { state: 'unavailable', error: 'probe_unavailable' }; }
    // 不等待 tick，也不 submit 探测命令；已阻塞的执行链不阻塞只读队列快照。
    const rows = this.rows().filter(row => row.target === target.id);
    const own = rows.filter(row => row.principal === subject.principal && row.scope === subject.scope);
    const queued = own.filter(row => row.phase === 'queued');
    const current = own.find(row => row.phase !== 'queued');
    const receipt = current && this.receipt(current);
    const lastError = this.db.prepare("SELECT id AS jobId,request_id AS requestId,json_extract(status,'$.error') AS error,created AS queuedAt FROM jobs WHERE principal=? AND scope=? AND target=? AND json_extract(status,'$.state') IN ('unknown','failed') ORDER BY created DESC,rowid DESC LIMIT 1").get(subject.principal, subject.scope, target.id);
    return {
      targetId: target.id, kind: target.kind, checkedAt: this.now(), readiness, ledger: this.ledger(subject, target),
      queue: {
        busy: rows.some(row => row.phase !== 'queued') || (target.kind === 'wsb' && Boolean(this.db.prepare("SELECT 1 FROM sessions WHERE target=? AND state!='closed'").get(target.id))),
        queued: queued.length, oldestQueuedAt: queued[0]?.created ?? null,
        current: current && receipt ? { requestId: receipt.requestId, jobId: receipt.jobId, ...(receipt.sessionId ? { sessionId: receipt.sessionId } : {}),
          deadline: receipt.deadline, queuedAt: current.created, state: receipt.state === 'cancelling' ? 'cancelling' : receipt.state === 'unknown' ? 'unknown' : 'running',
          ...(receipt.error ? { error: receipt.error } : {}) } : null,
      },
      lastError: Check(LastErrorSchema, lastError) ? lastError : null,
    };
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
    this.transaction(() => {
      const summary = this.details.summarize(row.id, status);
      this.db.prepare("UPDATE jobs SET phase=CASE WHEN phase='cancelling' AND ?='active' THEN 'cancelling' ELSE ? END,status=?,finished=CASE WHEN ?='terminal' THEN ? ELSE NULL END WHERE id=?").run(phase, phase, JSON.stringify(summary), phase, this.now(), row.id);
    });
    const execution = this.execution(row);
    if (execution.sessionId && phase === 'terminal') this.db.prepare('UPDATE sessions SET idle_until=MIN(expires,?) WHERE id=?').run(this.now() + (execution.target.kind === 'wsb' ? execution.target.idleTimeoutMs : 0), execution.sessionId);
  }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.advance().catch(() => { /* 下次轮询重查证据，绝不重新派发。 */ }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  archiveCompleted(): number { return this.details.archive(this.now() - COMPLETED_DETAILS_RETENTION_MS); }
  private async advance() {
    if (this.now() >= this.nextArchive) { this.archiveCompleted(); this.nextArchive = this.now() + 3600_000; }
    // 排队期限包含等待时间；不能让同 lane 的活跃任务阻止后续项按时结算。
    for (const row of this.rows()) if (row.phase === 'queued' && this.details.metadata(row.execution).deadline <= this.now()) this.finish(row, { state: 'cancelled' });
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

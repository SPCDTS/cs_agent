import type { DatabaseSync } from 'node:sqlite';
import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';
import type { Execution, ExecutionStatus } from './domain.ts';

export const COMPLETED_DETAILS_RETENTION_MS = 7 * 86400_000;
const resultSchema = Type.Object({ exitCode: Type.Integer(), stdout: Type.String(), stderr: Type.String(), truncated: Type.Boolean() });
const summarySchema = Type.Union([
  Type.Object({ state: Type.Literal('running') }),
  Type.Object({ state: Type.Literal('unknown'), error: Type.String() }),
  Type.Object({ state: Type.Literal('failed'), error: Type.String() }),
  Type.Object({ state: Type.Literal('cancelled') }),
  Type.Object({ state: Type.Literal('succeeded'), resultSummary: Type.Object({ exitCode: Type.Integer(), truncated: Type.Boolean() }) }),
]);
type Summary = Static<typeof summarySchema>;
const metadataSchema = Type.Object({ deadline: Type.Number(), sessionId: Type.Optional(Type.String()) });
const targetFields = { id: Type.String(), instructions: Type.Optional(Type.String()) };
const executionSchema = Type.Object({
  id: Type.String(), requestId: Type.String(), deadline: Type.Number(), sessionId: Type.Optional(Type.String()),
  subject: Type.Object({ principal: Type.String(), scope: Type.String() }),
  target: Type.Union([
    Type.Object({ ...targetFields, kind: Type.Literal('hyperv'), vmId: Type.String(), credentialPath: Type.String(), guestWorkdir: Type.String() }),
    Type.Object({ ...targetFields, kind: Type.Literal('wsb'), memoryMb: Type.Number(), idleTimeoutMs: Type.Number(), maxLifetimeMs: Type.Number() }),
  ]),
  command: Type.Object({ kind: Type.Literal('powershell'), script: Type.String(), cwd: Type.Optional(Type.String()), timeoutMs: Type.Number() }),
});

/** 正文可清理，jobs 中的身份、指纹、终态和退出摘要始终保留。 */
export class JobDetails {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync, now: number) {
    this.db = db;
    const migrated = db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name=?').get('jobs', 'finished');
    db.exec('CREATE TABLE IF NOT EXISTS job_payloads (id TEXT PRIMARY KEY, execution TEXT NOT NULL, result TEXT)');
    if (!migrated) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(`ALTER TABLE jobs ADD COLUMN finished INTEGER;
          INSERT INTO job_payloads(id,execution,result) SELECT id,execution,json_extract(status,'$.result') FROM jobs;
          UPDATE jobs SET execution=json_remove(execution,'$.command'),
            status=CASE WHEN json_extract(status,'$.state')='succeeded' THEN
              json_object('state','succeeded','resultSummary',json_object('exitCode',json_extract(status,'$.result.exitCode'),'truncated',json(CASE WHEN json_extract(status,'$.result.truncated')=1 THEN 'true' ELSE 'false' END)))
              ELSE status END;`);
        // 旧账本没有完成时间，迁移后再保留完整七天，不按创建时间提前清理。
        db.prepare("UPDATE jobs SET finished=? WHERE phase='terminal'").run(now);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    db.exec("CREATE INDEX IF NOT EXISTS jobs_active_created ON jobs(created) WHERE phase!='terminal'; CREATE INDEX IF NOT EXISTS jobs_finished ON jobs(finished)");
  }
  insert(execution: Execution) {
    this.db.prepare('INSERT INTO job_payloads(id,execution) VALUES(?,?)').run(execution.id, JSON.stringify(execution));
  }
  execution(id: string): Execution {
    const row = this.db.prepare('SELECT execution FROM job_payloads WHERE id=?').get(id);
    const value: unknown = row && typeof row.execution === 'string' ? JSON.parse(row.execution) : undefined;
    if (!Check(executionSchema, value)) throw new Error('job_execution_unavailable');
    return value;
  }
  metadata(encoded: string) {
    const value: unknown = JSON.parse(encoded);
    if (!Check(metadataSchema, value)) throw new Error('job_metadata_invalid');
    return { deadline: value.deadline, ...(value.sessionId ? { sessionId: value.sessionId } : {}) };
  }
  summarize(id: string, status: ExecutionStatus): Summary {
    if (status.state !== 'succeeded') return status;
    this.db.prepare('UPDATE job_payloads SET result=? WHERE id=?').run(JSON.stringify(status.result), id);
    return { state: 'succeeded', resultSummary: { exitCode: status.result.exitCode, truncated: status.result.truncated } };
  }
  read(id: string, encoded: string): { details: 'retained' | 'archived'; status: ExecutionStatus | Summary } {
    const value: unknown = JSON.parse(encoded);
    if (!Check(summarySchema, value)) throw new Error('job_status_invalid');
    const payload = this.db.prepare('SELECT result FROM job_payloads WHERE id=?').get(id);
    if (value.state === 'succeeded' && payload && typeof payload.result === 'string') {
      const result: unknown = JSON.parse(payload.result);
      if (!Check(resultSchema, result)) throw new Error('job_result_invalid');
      return { details: 'retained', status: { state: 'succeeded', result } };
    }
    return { details: payload ? 'retained' : 'archived', status: value };
  }
  archive(before: number): number {
    const result = this.db.prepare('DELETE FROM job_payloads WHERE id IN (SELECT id FROM jobs WHERE finished IS NOT NULL AND finished<=?)').run(before);
    // 已释放页会被后续任务复用；不做阻塞整个服务的 VACUUM。
    this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    return Number(result.changes);
  }
}

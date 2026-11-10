import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
/** 独立 SQLite 连接终身持有 OS 文件锁，进程崩溃后自动释放，无 PID 回收竞态。 */
export function acquireServiceLock(stateDir: string): () => void {
  const lock = new DatabaseSync(path.join(stateDir, 'service-lock.sqlite'));
  try { lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY)'); }
  catch (error) { lock.close(); throw new Error('service_lock_unavailable', { cause: error }); }
  let closed = false;
  return () => { if (!closed) { closed = true; lock.close(); } };
}

import type { DatabaseSync } from 'node:sqlite';
import type { Block, SessionRef, TurnIndex, Usage } from './types.js';

/** 只存定位与摘要；正文始终由适配器回到事实源读取。 */
export interface IndexedBlock {
  lineOffset: number;
  lineLength: number;
  lineHash?: string;
  item: number;
  offset: number;
  bytes: number;
  capacity?: number;
  kind: Block['kind'];
  ts?: number;
  callId?: string;
  meta?: Record<string, unknown>;
}
export interface IndexedTurn {
  index: TurnIndex;
  startOffset: number;
  endOffset: number;
  blocks: IndexedBlock[];
}
export interface CodexIndexState {
  version: 4;
  turns: IndexedTurn[];
  prelude?: IndexedBlock[];
  /** 基础指令只供上下文引用，不并入回合正文或 SSE。 */
  baselines?: IndexedBlock[];
  calls: Record<string, { turn: number; block: number; ts?: number }>;
  context?: { model?: string; effort?: string };
  lastUsageRecord?: string;
  pendingUsage?: boolean;
}
export interface SessionIndexFile {
  file: string;
  size: number;
  mtime: number;
  identity: string;
  head: string;
  tail: string;
  lastOffset: number;
  session: SessionRef;
  state: CodexIndexState;
}

interface IndexRow {
  file: string; size: number; mtime: number; identity: string; head: string; tail: string;
  last_offset: number; backend: SessionRef['backend']; session_id: string; scope: string | null;
  label: string; status: SessionRef['status']; started: number; updated: number; turns_json: string;
  state_json: string;
}

/** 与 ObsStore 共用 observability.sqlite，不另开正文数据库。 */
export class SessionIndex {
  private nextOffset: number;
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS session_index (
      file TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime REAL NOT NULL, identity TEXT NOT NULL,
      head TEXT NOT NULL, tail TEXT NOT NULL, last_offset INTEGER NOT NULL,
      backend TEXT NOT NULL, session_id TEXT NOT NULL, scope TEXT, label TEXT NOT NULL,
      status TEXT NOT NULL, started REAL NOT NULL, updated REAL NOT NULL,
      turns_json TEXT NOT NULL, usage_json TEXT, state_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS session_index_session ON session_index(backend,session_id);
      CREATE INDEX IF NOT EXISTS session_index_updated ON session_index(backend,updated);`);
    this.nextOffset = Number((db.prepare("SELECT value FROM obs_state WHERE key='sessions_next_offset'").get() as { value: number } | undefined)?.value ?? 0);
  }
  allocate(bytes: number): number {
    const offset = this.nextOffset;
    // 块之间保留一字节空隙，零长度内容也不能与其它块共用地址。
    this.nextOffset += bytes + 1;
    if (!Number.isSafeInteger(this.nextOffset)) throw new Error('会话内容索引超出范围');
    return offset;
  }
  all(backend: SessionRef['backend']): SessionIndexFile[] {
    return (this.db.prepare('SELECT * FROM session_index WHERE backend=? ORDER BY file').all(backend) as unknown as IndexRow[]).flatMap(row => {
      try {
        const state = JSON.parse(row.state_json) as CodexIndexState;
        if (state.version !== 4 || !Array.isArray(state.turns)) return [];
        return [{ file: row.file, size: row.size, mtime: row.mtime, identity: row.identity, head: row.head, tail: row.tail,
          lastOffset: row.last_offset, session: { backend: row.backend, id: row.session_id,
            ...(row.scope !== null ? { scope: row.scope } : {}), label: row.label, status: row.status,
            started: row.started, updated: row.updated, turns: state.turns.length }, state }];
      } catch { return []; }
    });
  }
  save(row: SessionIndexFile): void {
    const { session: s, state } = row;
    const turns = state.turns.map(t => ({ ...t.index, startOffset: t.startOffset, endOffset: t.endOffset }));
    this.db.exec('SAVEPOINT session_index_update');
    try {
      this.db.prepare(`INSERT INTO session_index VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(file) DO UPDATE SET
        size=excluded.size,mtime=excluded.mtime,identity=excluded.identity,head=excluded.head,tail=excluded.tail,
        last_offset=excluded.last_offset,backend=excluded.backend,session_id=excluded.session_id,scope=excluded.scope,
        label=excluded.label,status=excluded.status,started=excluded.started,updated=excluded.updated,
        turns_json=excluded.turns_json,usage_json=excluded.usage_json,state_json=excluded.state_json`).run(
        row.file,row.size,row.mtime,row.identity,row.head,row.tail,row.lastOffset,s.backend,s.id,s.scope ?? null,s.label,
        s.status,s.started,s.updated,JSON.stringify(turns),JSON.stringify(state.turns.at(-1)?.index.usage ?? null),JSON.stringify(state));
      this.db.prepare("INSERT INTO obs_state VALUES('sessions_next_offset',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(this.nextOffset);
      this.db.exec('RELEASE session_index_update');
    } catch (err) {
      this.db.exec('ROLLBACK TO session_index_update; RELEASE session_index_update');
      throw err;
    }
  }
  remove(file: string): void { this.db.prepare('DELETE FROM session_index WHERE file=?').run(file); }
}

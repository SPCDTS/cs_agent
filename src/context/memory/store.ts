/**
 * 记忆库（docs/MEMORY-DESIGN.md §4）：`${DATA_DIR}/memory.sqlite`，node:sqlite，WAL。
 * 条目 memories、版本 memory_versions、关系 memory_links；memories_fts 为 trigram FTS5，content 表同步触发器写法与消息库一致。
 * 只负责存取、版本与去重，不认识权限：调用方（agent/memory/service.ts）先按本轮权限求出命名空间范围再传入。
 * 时间一律为 unix 秒。与 ContextStore 同层但互不 import。
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  MEMORY_SUBJECT_MAX, MEMORY_TEXT_MAX, isMemoryNs,
  type MemoryInput, type MemoryKind, type MemoryLinkRow, type MemoryPatch, type MemoryQuery, type MemoryRow, type MemoryStatus, type MemoryVersionRow,
} from "./types.js";

const MEMORY_DB_FILE = "memory.sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ns TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('fact','preference','rule','commitment','episode')),
  subject TEXT,
  text TEXT NOT NULL,
  since INTEGER,
  until INTEGER,
  due_at INTEGER,
  done_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','retired','orphaned','forgotten')),
  author TEXT NOT NULL,
  source_scope TEXT,
  source_message_id TEXT,
  source_turn_id TEXT,
  confidence REAL NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_recalled_at INTEGER,
  recall_count INTEGER NOT NULL DEFAULT 0,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_ns_status_updated ON memories(ns, status, updated_at);
CREATE INDEX IF NOT EXISTS memories_hash ON memories(hash);
CREATE INDEX IF NOT EXISTS memories_due ON memories(ns, kind, status, due_at);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  text, subject, content='memories', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, text, subject) VALUES (new.id, new.text, new.subject);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text, subject) VALUES ('delete', old.id, old.text, old.subject);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF text, subject ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text, subject) VALUES ('delete', old.id, old.text, old.subject);
  INSERT INTO memories_fts(rowid, text, subject) VALUES (new.id, new.text, new.subject);
END;

CREATE TABLE IF NOT EXISTS memory_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  by TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT NOT NULL,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS memory_versions_memory ON memory_versions(memory_id, id);

CREATE TABLE IF NOT EXISTS memory_links (
  from_id INTEGER NOT NULL,
  to_id INTEGER NOT NULL,
  rel TEXT NOT NULL CHECK (rel IN ('supersedes','related')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id, rel)
);
CREATE INDEX IF NOT EXISTS memory_links_to ON memory_links(to_id);
`;

/** 规整：NFKC、折叠空白、ASCII 小写、去掉句末标点；只用于去重哈希，不改存储的正文。 */
export function normalizeMemoryText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim().replace(/[A-Z]/g, c => c.toLowerCase()).replace(/[。．.!！?？;；,，\s]+$/u, "");
}

export function memoryHash(ns: string, kind: MemoryKind, text: string): string {
  return createHash("sha256").update(`${ns}\n${kind}\n${normalizeMemoryText(text)}`).digest("hex");
}

/** 检索词：按空白切分，最多 5 个词。 */
function searchTerms(query: string): string[] {
  return query.split(/\s+/).filter(t => t.length > 0).slice(0, 5);
}

/**
 * 每个词都须命中 text 或 subject（子串）。`%`、`_`、`\` 按字面匹配：含这些字符的词转义并加 ESCAPE；
 * 不含的词保持普通 LIKE，trigram FTS 仍可走索引。
 */
function termsMatch(terms: readonly string[]): { sql: string; args: string[] } {
  const parts: string[] = [], args: string[] = [];
  for (const term of terms) {
    const special = /[%_\\]/.test(term), like = special ? "LIKE ? ESCAPE '\\'" : "LIKE ?";
    const pattern = `%${special ? term.replace(/[%_\\]/g, c => "\\" + c) : term}%`;
    parts.push(`(f.text ${like} OR f.subject ${like})`); args.push(pattern, pattern);
  }
  return { sql: parts.join(" AND "), args };
}

const nowSec = () => Math.floor(Date.now() / 1000);

export class MemoryStoreError extends Error {
  constructor(message: string) { super(message); this.name = "MemoryStoreError"; }
}

export interface RememberResult { row: MemoryRow; duplicate: boolean; superseded?: MemoryRow }

export class MemoryStore {
  readonly file: string;
  private readonly db: DatabaseSync;

  constructor(dataDir: string, private readonly now: () => number = nowSec) {
    mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, MEMORY_DB_FILE);
    this.db = new DatabaseSync(this.file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private version(id: number, by: string, before: MemoryRow | undefined, after: MemoryRow, reason?: string | null): void {
    this.db.prepare("INSERT INTO memory_versions (memory_id, at, by, before_json, after_json, reason) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, this.now(), by, before ? JSON.stringify(before) : null, JSON.stringify(after), reason ?? null);
  }

  get(id: number): MemoryRow | undefined {
    return this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | undefined;
  }

  /** 同命名空间、同种类、规整后正文相同的 active 条目。 */
  findActiveDuplicate(ns: string, kind: MemoryKind, text: string): MemoryRow | undefined {
    return this.db.prepare("SELECT * FROM memories WHERE hash = ? AND status = 'active' ORDER BY id LIMIT 1")
      .get(memoryHash(ns, kind, text)) as MemoryRow | undefined;
  }

  /**
   * 写入一条（§6 mem_remember）：hash 命中同命名空间的 active 条目时返回已有条目、不重复写；
   * 带 supersedes 时在同一事务里把旧条目标 superseded（until = 取代时间）并建 supersedes 链。旧条目须同命名空间且为 active。
   */
  remember(input: MemoryInput, opts: { supersedes?: number; reason?: string } = {}): RememberResult {
    const text = input.text.trim(), subject = input.subject?.trim() || null;
    if (!isMemoryNs(input.ns)) throw new MemoryStoreError("命名空间无效");
    if (!text || text.length > MEMORY_TEXT_MAX) throw new MemoryStoreError(`正文须为 1～${MEMORY_TEXT_MAX} 字`);
    if (subject && subject.length > MEMORY_SUBJECT_MAX) throw new MemoryStoreError(`subject 不超过 ${MEMORY_SUBJECT_MAX} 字`);
    return this.tx(() => {
      const now = this.now(), duplicate = this.findActiveDuplicate(input.ns, input.kind, text);
      let superseded: MemoryRow | undefined;
      // 取代与去重互不影响：新正文已有相同条目时，仍在同一事务里让它取代旧条目。
      if (opts.supersedes !== undefined && opts.supersedes !== duplicate?.id) {
        const old = this.get(opts.supersedes);
        if (!old || old.ns !== input.ns) throw new MemoryStoreError(`被取代的条目 #${opts.supersedes} 不存在或不在同一命名空间`);
        if (old.status !== "active") throw new MemoryStoreError(`条目 #${old.id} 已不是 active，不能再被取代`);
        // until 一律记为取代时间（§4.3），原先填的未来失效时间被覆盖
        this.db.prepare("UPDATE memories SET status = 'superseded', until = ?, updated_at = ? WHERE id = ?").run(now, now, old.id);
        superseded = this.get(old.id)!;
        this.version(old.id, input.author, old, superseded, "superseded");
      }
      if (duplicate) {
        if (superseded) this.db.prepare("INSERT OR IGNORE INTO memory_links (from_id, to_id, rel, created_at) VALUES (?, ?, 'supersedes', ?)").run(duplicate.id, superseded.id, now);
        return { row: duplicate, duplicate: true, ...(superseded ? { superseded } : {}) };
      }
      const row = this.db.prepare(`INSERT INTO memories (ns, kind, subject, text, since, until, due_at, status, author,
          source_scope, source_message_id, source_turn_id, confidence, created_at, updated_at, hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
        .get(input.ns, input.kind, subject, text, input.since ?? null, input.until ?? null, input.kind === "commitment" ? input.due_at ?? null : null,
          input.author, input.source_scope ?? null, input.source_message_id ?? null, input.source_turn_id ?? null, input.confidence ?? 1,
          now, now, memoryHash(input.ns, input.kind, text)) as unknown as MemoryRow;
      this.version(row.id, input.author, undefined, row, opts.reason ?? "remember");
      if (superseded) this.db.prepare("INSERT OR IGNORE INTO memory_links (from_id, to_id, rel, created_at) VALUES (?, ?, 'supersedes', ?)").run(row.id, superseded.id, now);
      return { row, duplicate: false, ...(superseded ? { superseded } : {}) };
    });
  }

  /** 改正文或时效（§6 mem_update）；正文变化时重算 hash。写一行版本。 */
  update(id: number, patch: MemoryPatch, by: string, reason?: string): MemoryRow {
    return this.tx(() => {
      const before = this.get(id);
      if (!before) throw new MemoryStoreError(`条目 #${id} 不存在`);
      const sets: string[] = [], args: SQLInputValue[] = [];
      const set = (column: string, value: SQLInputValue) => { sets.push(`${column} = ?`); args.push(value); };
      if (patch.text !== undefined) {
        const text = patch.text.trim();
        if (!text || text.length > MEMORY_TEXT_MAX) throw new MemoryStoreError(`正文须为 1～${MEMORY_TEXT_MAX} 字`);
        set("text", text); set("hash", memoryHash(before.ns, before.kind, text));
      }
      if (patch.subject !== undefined) {
        const subject = patch.subject?.trim() || null;
        if (subject && subject.length > MEMORY_SUBJECT_MAX) throw new MemoryStoreError(`subject 不超过 ${MEMORY_SUBJECT_MAX} 字`);
        set("subject", subject);
      }
      for (const key of ["since", "until", "due_at", "done_at"] as const) if (patch[key] !== undefined) set(key, patch[key]);
      if (!sets.length) throw new MemoryStoreError("没有要修改的字段");
      set("updated_at", this.now());
      this.db.prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
      const after = this.get(id)!;
      this.version(id, by, before, after, reason ?? "update");
      return after;
    });
  }

  /** 状态变更（遗忘、恢复、整理）；不删行，写一行版本。 */
  setStatus(id: number, status: MemoryStatus, by: string, reason?: string): MemoryRow {
    return this.tx(() => {
      const before = this.get(id);
      if (!before) throw new MemoryStoreError(`条目 #${id} 不存在`);
      if (before.status === status) return before;
      this.db.prepare("UPDATE memories SET status = ?, updated_at = ? WHERE id = ?").run(status, this.now(), id);
      const after = this.get(id)!;
      this.version(id, by, before, after, reason ?? status);
      return after;
    });
  }

  /** 遗忘前的状态：取最近一次变为 forgotten 的版本的 before；查不到为 active。 */
  statusBeforeForget(id: number): MemoryStatus {
    const rows = this.db.prepare("SELECT before_json, after_json FROM memory_versions WHERE memory_id = ? ORDER BY id DESC")
      .all(id) as { before_json: string | null; after_json: string }[];
    for (const row of rows) {
      const after = JSON.parse(row.after_json) as Partial<MemoryRow>, before = row.before_json ? JSON.parse(row.before_json) as Partial<MemoryRow> : undefined;
      if (after.status === "forgotten" && before?.status && before.status !== "forgotten") return before.status;
    }
    return "active";
  }

  private where(q: Omit<MemoryQuery, "limit">, alias = "m"): { sql: string; args: SQLInputValue[] } | null {
    const parts: string[] = [], args: SQLInputValue[] = [];
    if (q.scope !== "all") {
      const list = q.scope.filter(isMemoryNs);
      if (!list.length) return null;
      parts.push(`${alias}.ns IN (${list.map(() => "?").join(", ")})`); args.push(...list);
    }
    if (q.ns !== undefined) { parts.push(`${alias}.ns = ?`); args.push(q.ns); }
    if (q.kind) { parts.push(`${alias}.kind = ?`); args.push(q.kind); }
    if (q.subject) { parts.push(`${alias}.subject = ?`); args.push(q.subject.trim()); }
    if (q.status) { parts.push(`${alias}.status = ?`); args.push(q.status); }
    return { sql: parts.length ? " AND " + parts.join(" AND ") : "", args };
  }

  /**
   * 检索（§6 mem_search）：检索词全部命中 text 或 subject（trigram FTS；不足 3 字的词由 FTS5 回退扫描）；
   * 排序为最近召回优先、其次最新更新。缺省只查 active。
   */
  search(q: MemoryQuery): MemoryRow[] {
    const terms = searchTerms(q.query ?? "");
    const filter = this.where({ ...q, status: q.status ?? "active" });
    if (!filter || !terms.length) return [];
    const match = termsMatch(terms);
    return this.db.prepare(`SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.rowid WHERE ${match.sql}${filter.sql}
      ORDER BY COALESCE(m.last_recalled_at, 0) DESC, m.updated_at DESC, m.id DESC LIMIT ? OFFSET ?`)
      .all(...match.args, ...filter.args, Math.max(0, Math.floor(q.limit)), Math.max(0, q.offset ?? 0)) as unknown as MemoryRow[];
  }

  /** 列表（§6 mem_list）：缺省最近更新在前；kind=commitment 时按 due_at 升序、无截止的在后。缺省只列 active。 */
  list(q: MemoryQuery): MemoryRow[] {
    const filter = this.where({ ...q, status: q.status ?? "active" });
    if (!filter) return [];
    const order = q.kind === "commitment" ? "CASE WHEN m.due_at IS NULL THEN 1 ELSE 0 END, m.due_at ASC, m.id ASC" : "m.updated_at DESC, m.id DESC";
    return this.db.prepare(`SELECT m.* FROM memories m WHERE 1 = 1${filter.sql} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...filter.args, Math.max(0, Math.floor(q.limit)), Math.max(0, q.offset ?? 0)) as unknown as MemoryRow[];
  }

  /** 面板列表：status 缺省表示全部状态，有检索词时走 FTS；返回总数供分页。 */
  browse(q: Omit<MemoryQuery, "scope">): { items: MemoryRow[]; total: number } {
    const filter = this.where({ ...q, scope: "all" })!;
    const match = termsMatch(searchTerms(q.query ?? ""));
    const from = match.sql ? `memories_fts f JOIN memories m ON m.id = f.rowid WHERE ${match.sql}` : "memories m WHERE 1 = 1";
    const args = [...match.args, ...filter.args];
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM ${from}${filter.sql}`).get(...args) as { n: number }).n;
    const items = this.db.prepare(`SELECT m.* FROM ${from}${filter.sql} ORDER BY m.updated_at DESC, m.id DESC LIMIT ? OFFSET ?`)
      .all(...args, Math.max(0, Math.floor(q.limit)), Math.max(0, q.offset ?? 0)) as unknown as MemoryRow[];
    return { items, total: Number(total) };
  }

  /** 未完成的承诺：active、未完成，按 due_at 升序、无截止的在后（§7 提示注入）。 */
  openCommitments(ns: string, limit = 10): MemoryRow[] {
    return this.db.prepare(`SELECT * FROM memories WHERE ns = ? AND kind = 'commitment' AND status = 'active' AND done_at IS NULL
      ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, id ASC LIMIT ?`).all(ns, limit) as unknown as MemoryRow[];
  }

  /** 命中条目记一次召回。 */
  touchRecall(ids: readonly number[]): void {
    if (!ids.length) return;
    const now = this.now();
    const stmt = this.db.prepare("UPDATE memories SET last_recalled_at = ?, recall_count = recall_count + 1 WHERE id = ?");
    this.tx(() => { for (const id of ids) stmt.run(now, id); });
  }

  activeCount(ns: string): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE ns = ? AND status = 'active'").get(ns) as { n: number }).n);
  }

  versions(id: number): MemoryVersionRow[] {
    return this.db.prepare("SELECT * FROM memory_versions WHERE memory_id = ? ORDER BY id").all(id) as unknown as MemoryVersionRow[];
  }

  /** 与该条目相关的全部关系（作为取代者或被取代者）。 */
  links(id: number): MemoryLinkRow[] {
    return this.db.prepare("SELECT * FROM memory_links WHERE from_id = ? OR to_id = ? ORDER BY created_at, from_id, to_id")
      .all(id, id) as unknown as MemoryLinkRow[];
  }

  /** 面板命名空间筛选。 */
  namespaces(): string[] {
    return (this.db.prepare("SELECT DISTINCT ns FROM memories ORDER BY ns").all() as { ns: string }[]).map(r => r.ns);
  }
}

/**
 * 记忆库（docs/MEMORY-DESIGN.md §4）：`${DATA_DIR}/memory.sqlite`，node:sqlite，WAL。
 * 条目 memories、版本 memory_versions、关系 memory_links；memories_fts 为 trigram FTS5，content 表同步触发器写法与消息库一致。
 * 夜间整理（§9）另用 memory_proposals（画像提议）、memory_pair_checks（近似冲突已判过的对）、memory_meta（上次整理时间与报告）。
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
CREATE INDEX IF NOT EXISTS memory_versions_by ON memory_versions(by);

CREATE TABLE IF NOT EXISTS memory_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ns TEXT NOT NULL,
  text TEXT NOT NULL,
  based_on_revision TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  decided_at INTEGER,
  applied_revision TEXT,
  entries_hash TEXT
);
CREATE INDEX IF NOT EXISTS memory_proposals_ns ON memory_proposals(ns, status, id);

CREATE TABLE IF NOT EXISTS memory_pair_checks (
  a_id INTEGER NOT NULL,
  b_id INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  a_updated INTEGER NOT NULL,
  b_updated INTEGER NOT NULL,
  PRIMARY KEY (a_id, b_id)
);

CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
  /** invalid：参数或状态不允许；not_found：对象不存在；conflict：已处理过或状态已变 */
  constructor(message: string, readonly code: "invalid" | "not_found" | "conflict" = "invalid") { super(message); this.name = "MemoryStoreError"; }
}

/** 整理生成的画像改写提议（docs/MEMORY-DESIGN.md §9 第 5 步）：待确认，采纳时以 based_on_revision 做 CAS 写入画像。时间为秒。 */
export interface MemoryProposalRow {
  id: number;
  ns: string;
  text: string;
  based_on_revision: string;
  batch_id: string;
  created_at: number;
  status: "pending" | "accepted" | "rejected";
  decided_at: number | null;
  /** 采纳后写入画像得到的 revision */
  applied_revision: string | null;
  /** 生成时 active 候选集合（preference / rule 的 id 与 updated_at）的指纹 */
  entries_hash: string | null;
}

/** 一个整理批次（按版本记录聚合）：变更条数、最近变更时间（秒）、是否已回退。 */
export interface MemoryBatchRow { batch_id: string; ns: string; changes: number; at: number; rolled_back: boolean }

/** 版本 by 字段的整理与回退前缀（§4.2）。 */
export const CONSOLIDATE_BY = "consolidate:";
export const ROLLBACK_BY = "rollback:";

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

  private version(id: number, by: string, before: MemoryRow | undefined, after: MemoryRow, reason?: string | null, at = this.now()): void {
    this.db.prepare("INSERT INTO memory_versions (memory_id, at, by, before_json, after_json, reason) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, at, by, before ? JSON.stringify(before) : null, JSON.stringify(after), reason ?? null);
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

  // ───────────── 夜间整理（§9） ─────────────

  /**
   * 取代：把 loser 标 superseded（until = 取代时间）并建 winner → loser 的 supersedes 链，写一行版本。
   * 两条须同命名空间、都为 active 且不是同一条；版本时间与链接时间相同，整批回退据此删去本次建的链。
   */
  supersede(winnerId: number, loserId: number, by: string, reason?: string): MemoryRow {
    return this.tx(() => {
      const winner = this.get(winnerId), loser = this.get(loserId);
      if (!winner || !loser || winnerId === loserId) throw new MemoryStoreError(`条目 #${winnerId} 或 #${loserId} 不存在`, "not_found");
      if (winner.ns !== loser.ns) throw new MemoryStoreError("取代只能发生在同一命名空间");
      if (winner.status !== "active" || loser.status !== "active")
        throw new MemoryStoreError(`条目 #${winner.status !== "active" ? winner.id : loser.id} 已不是 active`, "conflict");
      const now = this.now();
      this.db.prepare("UPDATE memories SET status = 'superseded', until = ?, updated_at = ? WHERE id = ?").run(now, now, loser.id);
      this.db.prepare("INSERT OR IGNORE INTO memory_links (from_id, to_id, rel, created_at) VALUES (?, ?, 'supersedes', ?)").run(winner.id, loser.id, now);
      const after = this.get(loser.id)!;
      this.version(loser.id, by, loser, after, reason ?? "superseded", now);
      return after;
    });
  }

  /** 建一条 related 关系（整理判定"并存"）。 */
  relate(fromId: number, toId: number): void {
    this.db.prepare("INSERT OR IGNORE INTO memory_links (from_id, to_id, rel, created_at) VALUES (?, ?, 'related', ?)").run(fromId, toId, this.now());
  }

  /** 同 hash 的 active 条目组（≥2 条），组内按创建先后。 */
  duplicateGroups(ns: string): MemoryRow[][] {
    const rows = this.db.prepare(`SELECT m.* FROM memories m JOIN (SELECT hash FROM memories WHERE ns = ? AND status = 'active'
        GROUP BY hash HAVING COUNT(*) > 1) d ON d.hash = m.hash WHERE m.ns = ? AND m.status = 'active' ORDER BY m.hash, m.created_at, m.id`)
      .all(ns, ns) as unknown as MemoryRow[];
    const groups = new Map<string, MemoryRow[]>();
    for (const row of rows) groups.set(row.hash, [...(groups.get(row.hash) ?? []), row]);
    return [...groups.values()];
  }

  /** 带 subject 的 active 条目（近似冲突的候选），按 subject 排、同 subject 最新在前。 */
  activeWithSubject(ns: string): MemoryRow[] {
    return this.db.prepare("SELECT * FROM memories WHERE ns = ? AND status = 'active' AND subject IS NOT NULL ORDER BY subject, updated_at DESC, id DESC")
      .all(ns) as unknown as MemoryRow[];
  }

  /** 来源可查的抽取条目：active、author = extractor、来源会话与消息 id 齐全、创建不早于 since（秒）。 */
  orphanCandidates(ns: string, since: number): MemoryRow[] {
    return this.db.prepare(`SELECT * FROM memories WHERE ns = ? AND status = 'active' AND author = 'extractor' AND source_scope IS NOT NULL
        AND source_message_id IS NOT NULL AND source_message_id <> '' AND created_at >= ? ORDER BY id`).all(ns, since) as unknown as MemoryRow[];
  }

  /** 长期未召回的经历：active 的 episode，最近召回（没有召回看创建时间）早于 before（秒）。 */
  staleEpisodes(ns: string, before: number): MemoryRow[] {
    return this.db.prepare(`SELECT * FROM memories WHERE ns = ? AND kind = 'episode' AND status = 'active'
        AND COALESCE(last_recalled_at, created_at) < ? ORDER BY id`).all(ns, before) as unknown as MemoryRow[];
  }

  /** 某几种 active 条目，最新更新在前。 */
  activeOfKinds(ns: string, kinds: readonly MemoryKind[], limit = 1000): MemoryRow[] {
    if (!kinds.length) return [];
    return this.db.prepare(`SELECT * FROM memories WHERE ns = ? AND status = 'active' AND kind IN (${kinds.map(() => "?").join(", ")})
        ORDER BY updated_at DESC, id DESC LIMIT ?`).all(ns, ...kinds, limit) as unknown as MemoryRow[];
  }

  /**
   * 这一对条目上次的整理判定（a、b 不分先后）。指纹为送审时双方的 updated_at：任一方之后改过（正文、时效、状态）指纹就对不上，
   * 调用方据此重新送审。
   */
  pairCheck(a: Pick<MemoryRow, "id" | "updated_at">, b: Pick<MemoryRow, "id" | "updated_at">): { verdict: string; unchanged: boolean } | undefined {
    const [x, y] = a.id < b.id ? [a, b] : [b, a];
    const row = this.db.prepare("SELECT verdict, a_updated, b_updated FROM memory_pair_checks WHERE a_id = ? AND b_id = ?")
      .get(x.id, y.id) as { verdict: string; a_updated: number; b_updated: number } | undefined;
    return row && { verdict: row.verdict, unchanged: row.a_updated === x.updated_at && row.b_updated === y.updated_at };
  }

  /** 记一对条目的判定，指纹取送审时双方的 updated_at。 */
  recordPairCheck(a: Pick<MemoryRow, "id" | "updated_at">, b: Pick<MemoryRow, "id" | "updated_at">, verdict: string, batchId: string): void {
    const [x, y] = a.id < b.id ? [a, b] : [b, a];
    this.db.prepare(`INSERT INTO memory_pair_checks (a_id, b_id, verdict, batch_id, at, a_updated, b_updated) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(a_id, b_id) DO UPDATE SET verdict = excluded.verdict, batch_id = excluded.batch_id, at = excluded.at,
        a_updated = excluded.a_updated, b_updated = excluded.b_updated`)
      .run(x.id, y.id, verdict, batchId, this.now(), x.updated_at, y.updated_at);
  }

  /** 清理任一方已不是 active 的判定记录（不会再参与配对），返回删除行数。 */
  prunePairChecks(): number {
    return Number(this.db.prepare(`DELETE FROM memory_pair_checks WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = a_id AND m.status = 'active')
      OR NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = b_id AND m.status = 'active')`).run().changes);
  }

  /**
   * 整批回退（§9）：把 by = consolidate:<batch_id> 的版本按逆序恢复到 before 的状态与 until（正文不动），写新版本 by = rollback:<batch_id>。
   * 条目在该版本之后还有任何版本（不论谁写的）时跳过，不覆盖后来的变更；取代时建的 supersedes 链一并删去。
   * 批次没有任何版本 → not_found；已回退过 → conflict。
   */
  rollbackBatch(batchId: string): { restored: number; skipped: number } {
    const by = CONSOLIDATE_BY + batchId, rb = ROLLBACK_BY + batchId;
    return this.tx(() => {
      const rows = this.db.prepare("SELECT * FROM memory_versions WHERE by = ? ORDER BY id DESC").all(by) as unknown as MemoryVersionRow[];
      if (!rows.length) throw new MemoryStoreError(`批次 ${batchId} 没有可回退的变更`, "not_found");
      if (this.db.prepare("SELECT 1 FROM memory_versions WHERE by = ? LIMIT 1").get(rb)) throw new MemoryStoreError(`批次 ${batchId} 已经回退过`, "conflict");
      let restored = 0, skipped = 0;
      for (const v of rows) {
        const cur = this.get(v.memory_id);
        if (!v.before_json || !cur) { skipped++; continue; }
        if (this.db.prepare("SELECT 1 FROM memory_versions WHERE memory_id = ? AND id > ? LIMIT 1").get(cur.id, v.id)) { skipped++; continue; }
        const before = JSON.parse(v.before_json) as MemoryRow, after = JSON.parse(v.after_json) as MemoryRow;
        this.db.prepare("UPDATE memories SET status = ?, until = ?, updated_at = ? WHERE id = ?").run(before.status, before.until, this.now(), cur.id);
        if (after.status === "superseded" && before.status !== "superseded")
          this.db.prepare("DELETE FROM memory_links WHERE to_id = ? AND rel = 'supersedes' AND created_at = ?").run(cur.id, v.at);
        this.version(cur.id, rb, cur, this.get(cur.id)!, "rollback");
        restored++;
      }
      return { restored, skipped };
    });
  }

  /** 最近的整理批次（有版本记录的），最新在前；时间为秒。 */
  consolidateBatches(limit = 10): MemoryBatchRow[] {
    const rows = this.db.prepare(`SELECT substr(v.by, ${CONSOLIDATE_BY.length + 1}) AS batch_id, MIN(m.ns) AS ns, COUNT(*) AS changes, MAX(v.at) AS at, MAX(v.id) AS last
        FROM memory_versions v JOIN memories m ON m.id = v.memory_id WHERE v.by LIKE '${CONSOLIDATE_BY}%' GROUP BY v.by ORDER BY last DESC LIMIT ?`)
      .all(Math.max(1, Math.floor(limit))) as { batch_id: string; ns: string; changes: number; at: number }[];
    const done = this.db.prepare("SELECT 1 FROM memory_versions WHERE by = ? LIMIT 1");
    return rows.map(r => ({ batch_id: r.batch_id, ns: r.ns, changes: Number(r.changes), at: Number(r.at), rolled_back: !!done.get(ROLLBACK_BY + r.batch_id) }));
  }

  /** 新的画像提议：同一命名空间只保留一条 pending，新的覆盖旧的。 */
  putProposal(p: { ns: string; text: string; based_on_revision: string; batch_id: string; entries_hash: string }): MemoryProposalRow {
    if (!isMemoryNs(p.ns)) throw new MemoryStoreError("命名空间无效");
    return this.tx(() => {
      this.db.prepare("DELETE FROM memory_proposals WHERE ns = ? AND status = 'pending'").run(p.ns);
      return this.db.prepare("INSERT INTO memory_proposals (ns, text, based_on_revision, batch_id, created_at, entries_hash) VALUES (?, ?, ?, ?, ?, ?) RETURNING *")
        .get(p.ns, p.text, p.based_on_revision, p.batch_id, this.now(), p.entries_hash) as unknown as MemoryProposalRow;
    });
  }

  proposal(id: number): MemoryProposalRow | undefined {
    return this.db.prepare("SELECT * FROM memory_proposals WHERE id = ?").get(id) as MemoryProposalRow | undefined;
  }

  /** 提议列表，最新在前；status 缺省为 pending。 */
  proposals(status: MemoryProposalRow["status"] = "pending", limit = 20): MemoryProposalRow[] {
    return this.db.prepare("SELECT * FROM memory_proposals WHERE status = ? ORDER BY id DESC LIMIT ?").all(status, limit) as unknown as MemoryProposalRow[];
  }

  /** 该命名空间最近的一条提议（任何状态）。 */
  latestProposal(ns: string): MemoryProposalRow | undefined {
    return this.db.prepare("SELECT * FROM memory_proposals WHERE ns = ? ORDER BY id DESC LIMIT 1").get(ns) as MemoryProposalRow | undefined;
  }

  /** 采纳或拒绝一条 pending 提议；已处理过 → conflict。 */
  decideProposal(id: number, status: "accepted" | "rejected", appliedRevision?: string): MemoryProposalRow {
    return this.tx(() => {
      const row = this.proposal(id);
      if (!row) throw new MemoryStoreError(`提议 #${id} 不存在`, "not_found");
      if (row.status !== "pending") throw new MemoryStoreError(`提议 #${id} 已${row.status === "accepted" ? "采纳" : "拒绝"}`, "conflict");
      this.db.prepare("UPDATE memory_proposals SET status = ?, decided_at = ?, applied_revision = ? WHERE id = ?").run(status, this.now(), appliedRevision ?? null, id);
      return this.proposal(id)!;
    });
  }

  getMeta(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM memory_meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO memory_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
}

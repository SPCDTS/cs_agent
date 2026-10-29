import { createHash } from "node:crypto";
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/chord/sqlite";
import type { MemoryInput, MemoryKind, MemoryPatch, MemoryRow, MemoryStatus } from "./types";
import type { MemoryImport } from "./import";
import { containsSecret } from "./secrets";

export const nowSec = () => Math.floor(Date.now() / 1000);
export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
export const normalizeMemoryText = (text: string) => text.normalize("NFKC").replace(/\s+/g, " ").trim()
  .replace(/[A-Z]/g, c => c.toLowerCase()).replace(/[。．.!！?？;；,，\s]+$/u, "");
export const memoryHash = (ns: string, kind: MemoryKind, text: string) => sha256(`${ns}\n${kind}\n${normalizeMemoryText(text)}`);
export type Profile = { text: string; revision: string };
export type MemoryQuery = { query?: string; kind?: MemoryKind; subject?: string; status?: MemoryStatus; limit?: number };

export class MemoryStoreError extends Error {}
export class MemoryStore {
  constructor(readonly db: SqliteDatabase, readonly ns: string, private readonly now = nowSec) {}

  get(id: number, tx: SqliteExecutor = this.db): Promise<MemoryRow | undefined> {
    return tx.get<MemoryRow>("SELECT * FROM memories WHERE id = ? AND ns = ?", id, this.ns);
  }
  findActiveDuplicate(kind: MemoryKind, text: string, tx: SqliteExecutor = this.db) {
    return tx.get<MemoryRow>("SELECT * FROM memories WHERE ns = ? AND hash = ? AND status = 'active' ORDER BY id LIMIT 1", this.ns, memoryHash(this.ns, kind, text));
  }
  private async version(tx: SqliteExecutor, before: MemoryRow | undefined, after: MemoryRow, by: string, reason: string) {
    await tx.run("INSERT INTO memory_versions (memory_id, at, by, before_json, after_json, reason) VALUES (?, ?, ?, ?, ?, ?)",
      after.id, this.now(), by, before ? JSON.stringify(before) : null, JSON.stringify(after), reason);
  }
  async remember(input: Omit<MemoryInput, "ns">, options: { supersedes?: number; reason?: string } = {}) {
    const text = input.text.trim(), subject = input.subject?.trim() || null;
    if (!text || text.length > 500 || (subject?.length ?? 0) > 40) throw new MemoryStoreError("正文或 subject 长度无效");
    return this.db.transaction(async tx => {
      const now = this.now(), duplicate = await this.findActiveDuplicate(input.kind, text, tx);
      let superseded: MemoryRow | undefined;
      if (options.supersedes !== undefined && options.supersedes !== duplicate?.id) {
        const old = await this.get(options.supersedes, tx);
        if (!old || old.status !== "active") throw new MemoryStoreError("只能取代本会话的 active 条目，请先用 mem_search 查找");
        superseded = { ...old, status: "superseded", until: now, updated_at: now };
        await tx.run("UPDATE memories SET status = 'superseded', until = ?, updated_at = ? WHERE id = ?", now, now, old.id);
        await this.version(tx, old, superseded, input.author, "superseded");
      }
      let row = duplicate;
      if (!row) {
        row = await tx.get<MemoryRow>(`INSERT INTO memories (ns, kind, subject, text, since, until, due_at, author,
          source_scope, source_message_id, source_turn_id, confidence, created_at, updated_at, hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        this.ns, input.kind, subject, text, input.since ?? null, input.until ?? null, input.kind === "commitment" ? input.due_at ?? null : null,
        input.author, input.source_scope ?? null, input.source_message_id ?? null, input.source_turn_id ?? null, input.confidence ?? 1, now, now, memoryHash(this.ns, input.kind, text));
        if (!row) throw new MemoryStoreError("记忆写入失败");
        await this.version(tx, undefined, row, input.author, options.reason ?? "remember");
      }
      if (superseded) await tx.run("INSERT OR IGNORE INTO memory_links (from_id, to_id, rel, created_at) VALUES (?, ?, 'supersedes', ?)", row.id, superseded.id, now);
      return { row, duplicate: !!duplicate, superseded };
    });
  }
  async update(id: number, patch: MemoryPatch, by: string): Promise<MemoryRow> {
    return this.db.transaction(async tx => {
      const before = await this.get(id, tx);
      if (!before || before.status !== "active") throw new MemoryStoreError("只能修改本会话的 active 条目");
      const sets: string[] = [], args: SqliteValue[] = [];
      const set = (key: string, value: SqliteValue) => { sets.push(`${key} = ?`); args.push(value); };
      if (patch.text !== undefined) {
        const text = patch.text.trim();
        if (!text || text.length > 500) throw new MemoryStoreError("正文须为 1～500 字");
        set("text", text); set("hash", memoryHash(this.ns, before.kind, text));
      }
      if (patch.subject !== undefined) {
        if ((patch.subject?.trim().length ?? 0) > 40) throw new MemoryStoreError("subject 不超过 40 字");
        set("subject", patch.subject?.trim() || null);
      }
      if (before.kind !== "commitment" && (patch.due_at !== undefined || patch.done_at !== undefined)) throw new MemoryStoreError("due_at / done_at 只适用于 commitment");
      for (const key of ["since", "until", "due_at", "done_at"] as const) if (patch[key] !== undefined) set(key, patch[key]);
      if (!sets.length) throw new MemoryStoreError("没有要修改的字段");
      set("updated_at", this.now());
      const after = await tx.get<MemoryRow>(`UPDATE memories SET ${sets.join(", ")} WHERE id = ? RETURNING *`, ...args, id);
      if (!after) throw new MemoryStoreError("记忆不存在");
      await this.version(tx, before, after, by, "mem_update");
      return after;
    });
  }
  async forget(id: number, by: string, reason: string): Promise<void> {
    await this.db.transaction(async tx => {
      const before = await this.get(id, tx);
      if (!before) throw new MemoryStoreError("没有可修改的记忆，请先用 mem_search 查找");
      if (before.status === "forgotten") return;
      const after: MemoryRow = { ...before, status: "forgotten", updated_at: this.now() };
      await tx.run("UPDATE memories SET status = 'forgotten', updated_at = ? WHERE id = ?", after.updated_at, id);
      await this.version(tx, before, after, by, reason);
    });
  }
  async supersede(winnerId: number, loserId: number, by: string, reason: string): Promise<MemoryRow> {
    return this.db.transaction(async tx => {
      const winner = await this.get(winnerId, tx), loser = await this.get(loserId, tx);
      if (!winner || !loser || winnerId === loserId) throw new MemoryStoreError("条目不存在");
      if (winner.status !== "active" || loser.status !== "active") throw new MemoryStoreError("只能取代 active 条目");
      const now = this.now(), after: MemoryRow = { ...loser, status: "superseded", until: now, updated_at: now };
      await tx.run("UPDATE memories SET status = 'superseded', until = ?, updated_at = ? WHERE id = ?", now, now, loser.id);
      await tx.run("INSERT OR IGNORE INTO memory_links (from_id, to_id, rel, created_at) VALUES (?, ?, 'supersedes', ?)", winner.id, loser.id, now);
      await this.version(tx, loser, after, by, reason);
      return after;
    });
  }
  async setStatus(id: number, status: MemoryStatus, by: string, reason: string): Promise<MemoryRow> {
    return this.db.transaction(async tx => {
      const before = await this.get(id, tx);
      if (!before) throw new MemoryStoreError("条目不存在");
      if (before.status === status) return before;
      const after: MemoryRow = { ...before, status, updated_at: this.now() };
      await tx.run("UPDATE memories SET status = ?, updated_at = ? WHERE id = ?", status, after.updated_at, id);
      await this.version(tx, before, after, by, reason);
      return after;
    });
  }
  async relate(fromId: number, toId: number): Promise<void> {
    await this.db.run("INSERT OR IGNORE INTO memory_links (from_id, to_id, rel, created_at) VALUES (?, ?, 'related', ?)", fromId, toId, this.now());
  }
  search(q: MemoryQuery): Promise<MemoryRow[]> {
    const args: SqliteValue[] = [this.ns, q.status ?? "active"], parts = ["m.ns = ?", "m.status = ?"];
    if (q.kind) { parts.push("m.kind = ?"); args.push(q.kind); }
    if (q.subject) { parts.push("m.subject = ?"); args.push(q.subject.trim()); }
    const terms = q.query?.trim().split(/\s+/).filter(Boolean).slice(0, 5) ?? [];
    // 与 Docker 相同：FTS trigram 的 LIKE 可索引长词；短词与特殊字符按字面回退扫描。
    for (const term of terms) {
      const special = /[%_\\]/.test(term), like = special ? "LIKE ? ESCAPE '\\'" : "LIKE ?";
      const pattern = `%${special ? term.replace(/[%_\\]/g, "\\$&") : term}%`;
      parts.push(`(f.text ${like} OR f.subject ${like})`); args.push(pattern, pattern);
    }
    const from = terms.length ? "memories_fts f JOIN memories m ON m.id = f.rowid" : "memories m";
    const order = terms.length ? "COALESCE(m.last_recalled_at, 0) DESC, m.updated_at DESC, m.id DESC"
      : q.kind === "commitment" ? "m.due_at IS NULL, m.due_at, m.id" : "m.updated_at DESC, m.id DESC";
    return this.db.all<MemoryRow>(`SELECT m.* FROM ${from} WHERE ${parts.join(" AND ")} ORDER BY ${order} LIMIT ?`,
      ...args, Math.min(20, Math.max(1, q.limit ?? (terms.length ? 10 : 20))));
  }
  openCommitments() {
    return this.db.all<MemoryRow>(`SELECT * FROM memories WHERE ns = ? AND kind = 'commitment' AND status = 'active' AND done_at IS NULL
      ORDER BY due_at IS NULL, due_at, id LIMIT 10`, this.ns);
  }
  async touchRecall(ids: readonly number[]) {
    await this.db.transaction(async tx => {
      for (const id of ids) await tx.run("UPDATE memories SET last_recalled_at = ?, recall_count = recall_count + 1 WHERE ns = ? AND id = ?", this.now(), this.ns, id);
    });
  }
  async profile(tx: SqliteExecutor = this.db): Promise<Profile> {
    return await tx.get<Profile>("SELECT text, revision FROM profile WHERE ns = ?", this.ns) ?? { text: "", revision: "none" };
  }
  async writeProfile(text: string, expected: string): Promise<{ ok: boolean; current: Profile }> {
    text = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    if (new TextEncoder().encode(text).byteLength > 4096) throw new MemoryStoreError("画像超过 4 KiB 上限");
    if (containsSecret(text)) throw new MemoryStoreError("画像包含凭据样式的内容，禁止保存");
    return this.db.transaction(async tx => {
      const current = await this.profile(tx);
      if (current.revision !== expected) return { ok: false, current };
      const revision = sha256(text).slice(0, 16);
      await tx.run(`INSERT INTO profile (ns, text, revision, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(ns) DO UPDATE SET text=excluded.text, revision=excluded.revision, updated_at=excluded.updated_at`, this.ns, text, revision, this.now());
      return { ok: true, current: { text, revision } };
    });
  }
  async takeToolWrite(turnId: string) {
    const row = await this.db.get(`INSERT INTO memory_tool_writes(turn_id, writes) VALUES (?, 1)
      ON CONFLICT(turn_id) DO UPDATE SET writes=writes+1 WHERE writes < 20 RETURNING turn_id`, turnId);
    if (!row) throw new MemoryStoreError("本轮写入记忆已达上限（20 次）；本轮请勿重试，下一轮再写入。");
  }
  async import(data: MemoryImport) {
    if (data.ns !== this.ns) throw new MemoryStoreError("导入命名空间不匹配");
    return this.db.transaction(async tx => {
      let inserted = 0, skipped = 0;
      for (const input of data.memories) {
        // 重算 hash 防止导入文件中的旧算法或伪造哈希破坏后续精确去重；保留原 id 与来源。
        const row: MemoryRow = { id: input.id, ns: this.ns, kind: input.kind, text: input.text, subject: input.subject ?? null,
          since: input.since ?? null, until: input.until ?? null, due_at: input.due_at ?? null, done_at: input.done_at ?? null,
          status: input.status ?? "active", author: input.author, source_scope: input.source_scope ?? null,
          source_message_id: input.source_message_id ?? null, source_turn_id: input.source_turn_id ?? null, confidence: input.confidence ?? 1,
          created_at: input.created_at ?? this.now(), updated_at: input.updated_at ?? this.now(), last_recalled_at: input.last_recalled_at ?? null,
          recall_count: input.recall_count ?? 0, hash: memoryHash(this.ns, input.kind, input.text) };
        const keys = Object.keys(row);
        const added = await tx.get(`INSERT INTO memories (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")}) ON CONFLICT(id) DO NOTHING RETURNING id`, ...Object.values(row));
        if (added) { inserted++; await this.version(tx, undefined, row, "import", "import"); } else skipped++;
      }
      if (data.profile) {
        const text = data.profile.text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
        await tx.run(`INSERT INTO profile(ns,text,revision,updated_at) VALUES (?,?,?,?)
          ON CONFLICT(ns) DO UPDATE SET text=excluded.text,revision=excluded.revision,updated_at=excluded.updated_at`, this.ns, text, sha256(text).slice(0, 16), this.now());
      }
      return { inserted, skipped };
    });
  }
}

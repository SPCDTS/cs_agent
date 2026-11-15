import { Check } from "typebox/value";
import { CandidateInputSchema, type MemoryCandidate, type MemoryEditor } from "./editor";
import type { SqliteExecutor, SqliteValue } from "@earendil-works/chord/sqlite";
import { MemoryStore, MemoryStoreError, memoryHash, nowSec, sha256 } from "./store";
import type { MemoryKind, MemoryLinkRow, MemoryRow, MemoryStatus, MemoryVersionRow } from "./types";
import { parseSnapshot } from "./history-import";
import { effectiveMemory } from "./lifecycle";
import { containsSecret } from "./secrets";

export class MemoryAdminError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "invalid", _message: string = code) { super(`memory_admin:${code}`); }
}
export type MemoryListQuery = { status?: MemoryStatus | "all"; kind?: MemoryKind; query?: string; source?: "explicit" | "extractor"; validity?: "current" | "expired" | "future" | "open" | "done"; cursor?: number; page?: number; limit?: number };
export type ProfileProposal = {
  id: number; ns: string; text: string; based_on_revision: string; batch_id: string; created_at: number;
  entries_hash: string; status: "pending" | "accepted" | "rejected"; decided_at: number | null; applied_revision: string | null;
};
export type MemoryJob = { id: string; ns: string; status: "running" | "ok" | "failed" | "interrupted"; started_at: number; finished_at: number | null; report_json: string | null };

/** 管理操作只通过绑定的 store.ns 访问；版本号比秒级 updated_at 更适合作为 CAS。 */
export class MemoryManager {
  constructor(readonly store: MemoryStore, private readonly now = nowSec) {}
  private get db() { return this.store.db; }
  async save(id: number | null, input: MemoryEditor, expectedVersion?: number) {
    if (containsSecret(input.text) || input.subject && containsSecret(input.subject) || !input.text.trim()
      || input.until != null && input.since != null && input.until <= input.since
      || input.kind !== "commitment" && (input.due_at != null || input.done_at != null)) throw new MemoryAdminError("invalid");
    if (id === null) return (await this.store.remember({...input,author:"dashboard"})).row;
    try { return await this.store.update(id,input,"dashboard",expectedVersion); }
    catch(error) { if(error instanceof MemoryStoreError)throw new MemoryAdminError(error.message==="memory_admin:conflict"?"conflict":"invalid");throw error; }
  }
  candidates() { return this.db.all<MemoryCandidate>("SELECT * FROM memory_candidates WHERE ns=? AND status='pending' ORDER BY id DESC LIMIT 100",this.store.ns); }
  async decideCandidate(id: number, accept: boolean) {
    return this.db.transaction(async tx => {
      const candidate = await tx.get<MemoryCandidate>("SELECT * FROM memory_candidates WHERE id=? AND ns=?",id,this.store.ns);
      if (!candidate) throw new MemoryAdminError("not_found");
      if (candidate.status !== "pending") throw new MemoryAdminError("conflict");
      if (accept) {
        const input: unknown = JSON.parse(candidate.input_json);
        if (!Check(CandidateInputSchema,input) || containsSecret(input.text) || input.subject && containsSecret(input.subject)) throw new MemoryAdminError("invalid");
        const saved=await this.store.remember({...input,author:"dashboard"},{supersedes:candidate.target_id,expectedTargetVersion:candidate.target_version,reason:"confirmed_conflict"},tx);
        if(input.evidence && input.source_scope && input.source_message_id && !containsSecret(input.evidence.quote))
          await tx.run("INSERT OR IGNORE INTO memory_evidence(memory_id,scope,message_id,speaker,quote) VALUES (?,?,?,?,?)",saved.row.id,input.source_scope,input.source_message_id,input.evidence.speaker,input.evidence.quote);
      }
      await tx.run("UPDATE memory_candidates SET status=? WHERE id=?",accept?"accepted":"rejected",id);
      return {status:accept?"accepted":"rejected"};
    });
  }
  async list(q: MemoryListQuery = {}) {
    const limit = q.limit ?? 40, page = q.page ?? 1;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(page) || page < 1
      || q.cursor !== undefined && (!Number.isSafeInteger(q.cursor) || q.cursor < 1)
      || q.cursor !== undefined && page !== 1 || (q.query?.length ?? 0) > 200) throw new MemoryAdminError("invalid");
    const parts = ["ns = ?"], args: SqliteValue[] = [this.store.ns];
    if (q.status !== "all") { parts.push("status = ?"); args.push(q.status ?? "active"); }
    if (q.kind) { parts.push("kind = ?"); args.push(q.kind); }
    if (q.source) { parts.push(q.source === "extractor" ? "author='extractor'" : "author<>'extractor'"); }
    if (q.validity === "current") { parts.push(effectiveMemory()); args.push(this.now(),this.now()); }
    if (q.validity === "expired") { parts.push("kind<>'episode' AND until IS NOT NULL AND until<=?"); args.push(this.now()); }
    if (q.validity === "future") { parts.push("since>?"); args.push(this.now()); }
    if (q.validity === "open" || q.validity === "done") { parts.push("kind='commitment'",q.validity === "open" ? "done_at IS NULL" : "done_at IS NOT NULL"); }
    const id = /^#([1-9]\d{0,14})$/.exec(q.query?.trim() ?? "");
    if (id) { parts.push("id=?"); args.push(Number(id[1])); }
    for (const term of (id ? undefined : q.query)?.trim().split(/\s+/).filter(Boolean).slice(0, 5) ?? []) {
      parts.push("(instr(lower(text), lower(?)) > 0 OR instr(lower(COALESCE(subject, '')), lower(?)) > 0)"); args.push(term, term);
    }
    const total = (await this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM memories WHERE ${parts.join(" AND ")}`, ...args))?.n ?? 0;
    if (q.cursor !== undefined) { parts.push("id < ?"); args.push(q.cursor); }
    const rows = await this.db.all<MemoryRow>(`SELECT * FROM memories WHERE ${parts.join(" AND ")} ORDER BY id DESC LIMIT ? OFFSET ?`,
      ...args, limit + 1, (page - 1) * limit);
    const items = rows.slice(0, limit);
    return { items, total, page, limit, nextCursor: rows.length > limit ? items.at(-1)?.id ?? null : null };
  }
  async detail(id: number) {
    return this.db.transaction(async tx=>{
    const row = await this.store.get(id,tx);
    if (!row) throw new MemoryAdminError("not_found");
    const versions = await tx.all<MemoryVersionRow>("SELECT * FROM memory_versions WHERE memory_id = ? ORDER BY id DESC", id);
    const links = await tx.all<MemoryLinkRow>(`SELECT l.* FROM memory_links l
      JOIN memories a ON a.id = l.from_id JOIN memories b ON b.id = l.to_id
      WHERE a.ns = ? AND b.ns = ? AND (l.from_id = ? OR l.to_id = ?) ORDER BY l.created_at DESC, l.from_id, l.to_id`, this.store.ns, this.store.ns, id, id);
    const evidence = await tx.all<{scope:string;message_id:string;speaker:string;quote:string}>("SELECT scope,message_id,speaker,quote FROM memory_evidence WHERE memory_id=?",id);
    if(!evidence.length && row.source_scope && row.source_message_id) {
      const source=await tx.get<{user_id:string;text:string}>("SELECT user_id,text FROM messages WHERE scope=? AND message_id=?",row.source_scope,row.source_message_id);
      if(source && !containsSecret(source.text))evidence.push({scope:row.source_scope,message_id:row.source_message_id,speaker:source.user_id,quote:source.text.slice(0,500)});
    }
    const profile = await this.store.profile(tx);
    return { row, versions, links, evidence, inProfile: profile.sources?.includes(id) ?? false, revision: (await this.currentVersion(tx, id))?.id ?? 0 };
    });
  }
  private currentVersion(tx: SqliteExecutor, id: number) {
    return tx.get<MemoryVersionRow>(`SELECT * FROM memory_versions v WHERE memory_id = ?
      AND NOT EXISTS (SELECT 1 FROM memory_imported_versions h WHERE h.version_id = v.id) ORDER BY id DESC LIMIT 1`, id);
  }
  private async append(tx: SqliteExecutor, before: MemoryRow, after: MemoryRow, by: string, reason: string) {
    await tx.run("INSERT INTO memory_versions(memory_id, at, by, before_json, after_json, reason) VALUES (?,?,?,?,?,?)",
      after.id, this.now(), by, JSON.stringify(before), JSON.stringify(after), reason);
  }
  private async replace(tx: SqliteExecutor, current: MemoryRow, snapshot: MemoryRow, by: string, reason: string) {
    const after = { ...snapshot, id: current.id, ns: current.ns, updated_at: this.now(), hash: memoryHash(current.ns, snapshot.kind, snapshot.text),
      recall_count: current.recall_count, last_recalled_at: current.last_recalled_at };
    const fields = Object.entries(after).filter(([key]) => key !== "id" && key !== "ns");
    await tx.run(`UPDATE memories SET ${fields.map(([key]) => key + " = ?").join(",")} WHERE id = ? AND ns = ?`,
      ...fields.map(([, value]) => value), current.id, this.store.ns);
    await this.append(tx, current, after, by, reason);
    return after;
  }
  async restore(id: number, options: { expectedVersion: number; versionId?: number }, by = "dashboard") {
    return this.db.transaction(async tx => {
      const current = await this.store.get(id, tx);
      if (!current) throw new MemoryAdminError("not_found");
      const latest = await this.currentVersion(tx, id);
      if ((latest?.id ?? 0) !== options.expectedVersion) throw new MemoryAdminError("conflict");
      let snapshot: MemoryRow;
      if (options.versionId !== undefined) {
        const version = await tx.get<MemoryVersionRow>("SELECT * FROM memory_versions WHERE id = ? AND memory_id = ?", options.versionId, id);
        if (!version) throw new MemoryAdminError("not_found");
        snapshot = parseSnapshot(version.after_json, this.store.ns, id);
      } else {
        if (current.status !== "forgotten") throw new MemoryAdminError("conflict", "只能默认恢复已遗忘条目");
        const versions = await tx.all<MemoryVersionRow>("SELECT * FROM memory_versions v WHERE memory_id = ? AND before_json IS NOT NULL AND NOT EXISTS (SELECT 1 FROM memory_imported_versions h WHERE h.version_id = v.id) ORDER BY id DESC", id);
        const forgotten = versions.find(v => parseSnapshot(v.after_json, this.store.ns, id).status === "forgotten"
          && v.before_json !== null && parseSnapshot(v.before_json, this.store.ns, id).status !== "forgotten");
        if (!forgotten?.before_json) throw new MemoryAdminError("conflict", "没有遗忘前快照");
        snapshot = parseSnapshot(forgotten.before_json, this.store.ns, id);
      }
      return this.replace(tx, current, {...snapshot,author:by}, by, "restore");
    });
  }
  async rollback(batchId: string) {
    return this.db.transaction(async tx => {
      const job = await tx.get<MemoryJob>("SELECT * FROM memory_jobs WHERE id = ? AND ns = ?", batchId, this.store.ns);
      if (job?.status === "running") throw new MemoryAdminError("conflict");
      const versions = await tx.all<MemoryVersionRow>(`SELECT v.* FROM memory_versions v JOIN memories m ON m.id = v.memory_id
        WHERE m.ns = ? AND v.by = ? AND NOT EXISTS (SELECT 1 FROM memory_imported_versions h WHERE h.version_id = v.id) ORDER BY v.id`, this.store.ns, `consolidate:${batchId}`);
      if (!versions.length && !job) throw new MemoryAdminError("not_found");
      const entries = new Map<number, MemoryVersionRow[]>();
      for (const version of versions) entries.set(version.memory_id, [...entries.get(version.memory_id) ?? [], version]);
      let restored = 0, skipped = 0;
      for (const [id, changes] of entries) {
        const first = changes[0], last = changes.at(-1);
        const latest = await this.currentVersion(tx, id);
        const current = await this.store.get(id, tx);
        if (!first?.before_json || !last || !current || latest?.id !== last.id) { skipped++; continue; }
        const before = parseSnapshot(first.before_json, this.store.ns, id);
        // 只撤销整理负责的状态和 until；正文、来源、召回统计保留。
        await this.replace(tx, current, { ...current, status: before.status, until: before.until }, `rollback:${batchId}`, "rollback");
        restored++;
      }
      await tx.run("DELETE FROM memory_pair_checks WHERE batch_id = ? AND a_id IN (SELECT id FROM memories WHERE ns = ?)", batchId, this.store.ns);
      return { restored, skipped };
    });
  }
  async recoverInterruptedJobs() {
    await this.db.run("UPDATE memory_jobs SET status = 'interrupted', finished_at = ? WHERE ns = ? AND status = 'running'", Date.now(), this.store.ns);
  }
  jobs(limit = 40) { return this.db.all<MemoryJob>("SELECT * FROM memory_jobs WHERE ns = ? ORDER BY started_at DESC, id DESC LIMIT ?", this.store.ns, Math.min(100, Math.max(1, limit))); }
  async proposals(status: ProfileProposal["status"] | "all" = "pending") {
    return status === "all" ? this.db.all<ProfileProposal>("SELECT * FROM memory_proposals WHERE ns = ? ORDER BY id DESC LIMIT 100", this.store.ns)
      : this.db.all<ProfileProposal>("SELECT * FROM memory_proposals WHERE ns = ? AND status = ? ORDER BY id DESC LIMIT 100", this.store.ns, status);
  }
  latestProposal() { return this.db.get<ProfileProposal>("SELECT * FROM memory_proposals WHERE ns = ? ORDER BY id DESC LIMIT 1", this.store.ns); }
  async putProposal(input: { text: string; based_on_revision: string; batch_id: string; entries_hash: string }) {
    if (!input.text.trim() || new TextEncoder().encode(input.text).byteLength > 4096 || containsSecret(input.text)) throw new MemoryAdminError("invalid");
    return this.db.transaction(async tx => {
      const profile = await this.store.profile(tx);
      if (profile.revision !== input.based_on_revision) throw new MemoryAdminError("conflict");
      await tx.run("UPDATE memory_proposals SET status = 'rejected', decided_at = ? WHERE ns = ? AND status = 'pending'", this.now(), this.store.ns);
      const row = await tx.get<ProfileProposal>(`INSERT INTO memory_proposals(ns,text,based_on_revision,batch_id,created_at,entries_hash)
        VALUES (?,?,?,?,?,?) RETURNING *`, this.store.ns, input.text, input.based_on_revision, input.batch_id, this.now(), input.entries_hash);
      if (!row) throw new MemoryAdminError("invalid");
      return row;
    });
  }
  async decideProposal(id: number, decision: "accepted" | "rejected", expectedRevision: string) {
    return this.db.transaction(async tx => {
      const row = await tx.get<ProfileProposal>("SELECT * FROM memory_proposals WHERE id = ? AND ns = ?", id, this.store.ns);
      if (!row) throw new MemoryAdminError("not_found");
      const current = await this.store.profile(tx);
      if (row.status !== "pending" || current.revision !== expectedRevision
        || decision === "accepted" && current.revision !== row.based_on_revision) throw new MemoryAdminError("conflict");
      const revision = decision === "accepted" ? sha256(row.text).slice(0, 16) : null;
      if (decision === "accepted") {
        if (row.entries_hash !== await this.store.profileFingerprint(tx)) throw new MemoryAdminError("conflict");
        if (new TextEncoder().encode(row.text).byteLength > 4096 || containsSecret(row.text)) throw new MemoryAdminError("invalid");
        await tx.run(`INSERT INTO profile(ns,text,revision,updated_at) VALUES (?,?,?,?)
          ON CONFLICT(ns) DO UPDATE SET text=excluded.text,revision=excluded.revision,updated_at=excluded.updated_at`, this.store.ns, row.text, revision, this.now());
        await this.store.approveProfileSources(tx);
      }
      await tx.run("UPDATE memory_proposals SET status = ?, decided_at = ?, applied_revision = ? WHERE id = ? AND ns = ?", decision, this.now(), revision, id, this.store.ns);
      return { id, status: decision, revision };
    });
  }
}

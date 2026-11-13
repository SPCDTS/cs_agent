import type { MemoryRow } from "./types";

/** 新表独立追加，兼容已部署的记忆表与历史快照。 */
export const MEMORY_SUPPORT_SCHEMA = `
CREATE TABLE IF NOT EXISTS profile_sources (ns TEXT NOT NULL, memory_id INTEGER NOT NULL, PRIMARY KEY(ns,memory_id));
CREATE TABLE IF NOT EXISTS profile_review (ns TEXT PRIMARY KEY, reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memory_evidence (memory_id INTEGER NOT NULL, scope TEXT NOT NULL, message_id TEXT NOT NULL, speaker TEXT NOT NULL, quote TEXT NOT NULL, PRIMARY KEY(memory_id,scope,message_id));
CREATE TABLE IF NOT EXISTS memory_candidates (
 id INTEGER PRIMARY KEY AUTOINCREMENT, ns TEXT NOT NULL, input_json TEXT NOT NULL, target_id INTEGER NOT NULL,
 target_version INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL,
 UNIQUE(ns,input_json,target_id,target_version)
);
CREATE TABLE IF NOT EXISTS extract_attempts (turn_id TEXT PRIMARY KEY, attempts INTEGER NOT NULL, available_at INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT);
`;

export const MEMORY_LIFECYCLE_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS memory_profile_invalidate AFTER UPDATE OF text,subject,kind,status,since,until,due_at,done_at ON memories
WHEN old.text IS NOT new.text OR old.subject IS NOT new.subject OR old.kind IS NOT new.kind OR old.status IS NOT new.status
 OR old.since IS NOT new.since OR old.until IS NOT new.until OR old.due_at IS NOT new.due_at OR old.done_at IS NOT new.done_at
BEGIN
 INSERT INTO profile_review(ns,reason) SELECT ns,'记忆 #' || old.id || ' 已变化，请复核画像后保存。' FROM profile
 WHERE ns=old.ns AND trim(text)<>'' AND (NOT EXISTS(SELECT 1 FROM profile_sources WHERE ns=old.ns)
 OR EXISTS(SELECT 1 FROM profile_sources WHERE ns=old.ns AND memory_id=old.id))
 ON CONFLICT(ns) DO UPDATE SET reason=excluded.reason;
 UPDATE profile SET revision=lower(hex(randomblob(8))) WHERE ns=old.ns AND EXISTS(SELECT 1 FROM profile_review WHERE ns=old.ns);
END;
`;

export const effectiveMemory = (alias = "") => {
 const p = alias ? alias + "." : "";
 return `(${p}since IS NULL OR ${p}since <= ?) AND (${p}kind = 'episode' OR ${p}until IS NULL OR ${p}until > ?)`;
};
export function memoryIdentity(row: Pick<MemoryRow,"hash"|"subject"|"kind"|"since"|"until"|"due_at">): string {
 return JSON.stringify([row.hash, row.subject?.trim() || "", row.kind === "episode" ? [row.since,row.until] : null, row.kind === "commitment" ? row.due_at : null]);
}

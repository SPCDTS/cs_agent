// Frozen 14a9465 schemas: real populated-database initialization regression.
// 与 Pi 共用 SQLite，但表名保持独立；FTS 触发器确保修改与遗忘后索引一致。
export const LEGACY_MEMORY_SCHEMA = `
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

CREATE TABLE IF NOT EXISTS profile (ns TEXT PRIMARY KEY, text TEXT NOT NULL, revision TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS extract_queue (turn_id TEXT PRIMARY KEY, enqueued_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS extract_receipts (turn_id TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS extract_daily (day TEXT PRIMARY KEY, calls INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS memory_tool_writes (turn_id TEXT PRIMARY KEY, writes INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events (at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS thread_namespace (ns TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS memory_pair_checks (
  a_id INTEGER NOT NULL, b_id INTEGER NOT NULL, verdict TEXT NOT NULL, batch_id TEXT NOT NULL, at INTEGER NOT NULL,
  a_updated INTEGER NOT NULL, b_updated INTEGER NOT NULL, PRIMARY KEY (a_id, b_id)
);
CREATE TABLE IF NOT EXISTS memory_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ns TEXT NOT NULL, text TEXT NOT NULL, based_on_revision TEXT NOT NULL,
  batch_id TEXT NOT NULL, created_at INTEGER NOT NULL, entries_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  decided_at INTEGER, applied_revision TEXT
);
CREATE INDEX IF NOT EXISTS memory_proposals_ns ON memory_proposals(ns, status, id);
CREATE TABLE IF NOT EXISTS memory_jobs (
  id TEXT PRIMARY KEY, ns TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','ok','failed','interrupted')),
  started_at INTEGER NOT NULL, finished_at INTEGER, report_json TEXT
);
CREATE INDEX IF NOT EXISTS memory_jobs_ns ON memory_jobs(ns, started_at);
CREATE TABLE IF NOT EXISTS memory_imported_versions (version_id INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS memory_history_map (
  source TEXT NOT NULL, ns TEXT NOT NULL, legacy_id INTEGER NOT NULL, memory_id INTEGER NOT NULL,
  PRIMARY KEY(source, ns, legacy_id)
);
CREATE TABLE IF NOT EXISTS memory_history_receipts (
  source TEXT NOT NULL, ns TEXT NOT NULL, kind TEXT NOT NULL, legacy_id TEXT NOT NULL, digest TEXT NOT NULL,
  imported_at INTEGER NOT NULL, PRIMARY KEY(source, ns, kind, legacy_id)
);
`;

/** 前向追加；不修改既有 schema / 生命周期触发器。 */
export const LEGACY_MEMORY_RULE_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_rule_bindings (
 ns TEXT NOT NULL, memory_id INTEGER NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('enabled','disabled')),
 memory_version INTEGER NOT NULL, payload_hash TEXT NOT NULL, scope_key TEXT NOT NULL,
 approved_by TEXT NOT NULL, event_id TEXT NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(ns,memory_id)
);
CREATE TABLE IF NOT EXISTS memory_rule_sets (ns TEXT PRIMARY KEY, epoch INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS memory_rule_proposals (
 id TEXT PRIMARY KEY, ns TEXT NOT NULL, memory_id INTEGER NOT NULL, memory_version INTEGER NOT NULL,
 binding_revision INTEGER NOT NULL, scope_key TEXT NOT NULL, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_rule_operations (
 ns TEXT NOT NULL, request_id TEXT NOT NULL, input_hash TEXT NOT NULL, result_json TEXT NOT NULL, scope_key TEXT NOT NULL,
 PRIMARY KEY(ns,request_id)
);
CREATE TABLE IF NOT EXISTS memory_rule_binding_versions (
 ns TEXT NOT NULL, memory_id INTEGER NOT NULL, revision INTEGER NOT NULL,
 before_json TEXT, after_json TEXT NOT NULL, actor TEXT NOT NULL, event_id TEXT NOT NULL, at INTEGER NOT NULL,
 PRIMARY KEY(ns,memory_id,revision)
);
CREATE TRIGGER IF NOT EXISTS memory_rule_protect_update
BEFORE UPDATE OF ns,kind,subject,text,since,until,status,author,source_scope,source_message_id,source_turn_id ON memories
WHEN EXISTS(SELECT 1 FROM memory_rule_bindings WHERE ns=old.ns AND memory_id=old.id AND state='enabled')
BEGIN SELECT RAISE(ABORT,'memory_rule:protected'); END;
-- 前向增加保护：批准绑定 memory version，非正文的空值更新也不得生成新版本。
CREATE TRIGGER IF NOT EXISTS memory_rule_protect_aux_update
BEFORE UPDATE OF id,due_at,done_at,hash,created_at,updated_at,confidence ON memories
WHEN EXISTS(SELECT 1 FROM memory_rule_bindings WHERE ns=old.ns AND memory_id=old.id AND state='enabled')
BEGIN SELECT RAISE(ABORT,'memory_rule:protected'); END;
CREATE TRIGGER IF NOT EXISTS memory_rule_protect_version_insert BEFORE INSERT ON memory_versions
WHEN EXISTS(SELECT 1 FROM memory_rule_bindings WHERE memory_id=new.memory_id AND state='enabled')
BEGIN SELECT RAISE(ABORT,'memory_rule:protected'); END;
CREATE TRIGGER IF NOT EXISTS memory_rule_protect_delete BEFORE DELETE ON memories
WHEN EXISTS(SELECT 1 FROM memory_rule_bindings WHERE ns=old.ns AND memory_id=old.id AND state='enabled')
BEGIN SELECT RAISE(ABORT,'memory_rule:protected'); END;
CREATE TRIGGER IF NOT EXISTS memory_rule_profile_insert AFTER INSERT ON memory_rule_bindings
BEGIN
 INSERT INTO profile_review(ns,reason) SELECT ns,'规则批准状态已变化，请复核画像中的旧副本。' FROM profile
 WHERE ns=new.ns AND trim(text)<>'' ON CONFLICT(ns) DO UPDATE SET reason=excluded.reason;
 UPDATE profile SET revision=lower(hex(randomblob(8))) WHERE ns=new.ns AND EXISTS(SELECT 1 FROM profile_review WHERE ns=new.ns);
END;
CREATE TRIGGER IF NOT EXISTS memory_rule_profile_update AFTER UPDATE ON memory_rule_bindings
BEGIN
 INSERT INTO profile_review(ns,reason) SELECT ns,'规则批准状态已变化，请复核画像中的旧副本。' FROM profile
 WHERE ns=new.ns AND trim(text)<>'' ON CONFLICT(ns) DO UPDATE SET reason=excluded.reason;
 UPDATE profile SET revision=lower(hex(randomblob(8))) WHERE ns=new.ns AND EXISTS(SELECT 1 FROM profile_review WHERE ns=new.ns);
END;
`;

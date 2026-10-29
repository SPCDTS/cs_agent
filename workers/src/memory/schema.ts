// 与 Pi 共用 SQLite，但表名保持独立；FTS 触发器确保修改与遗忘后索引一致。
export const MEMORY_SCHEMA = `
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
`;

/** 前向追加；不修改既有 schema / 生命周期触发器。 */
export const MEMORY_RULE_SCHEMA = `
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

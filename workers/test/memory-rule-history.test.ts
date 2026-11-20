import { env, reset, runInDurableObject, evictDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { MemoryStore, memoryHash, sha256 } from "../src/memory/store";
import { RuleService, compileRules } from "../src/memory/rules";
import { MEMORY_SUPPORT_SCHEMA, MEMORY_LIFECYCLE_TRIGGERS } from "../src/memory/lifecycle";
import { LEGACY_MEMORY_SCHEMA, LEGACY_MEMORY_RULE_SCHEMA } from "./fixtures/memory-schema-14a9465";
import type { MemoryRow } from "../src/memory/types";

afterEach(()=>reset());
const tables=["memories","memory_versions","memory_imported_versions","memory_history_map","memory_history_receipts","memory_rule_bindings","memory_rule_sets","memory_rule_binding_versions","memory_rule_operations","memory_rule_proposals"];
async function snapshot(store:MemoryStore){return Object.fromEntries(await Promise.all(tables.map(async t=>[t,await store.db.all("SELECT * FROM "+t+" ORDER BY rowid")])));}
const historyJson=(row:MemoryRow)=>JSON.stringify({...row,text:"合成历史正文",hash:memoryHash("owner",row.kind,"合成历史正文")});
async function appendHistory(store:MemoryStore,row:MemoryRow,reason="archive"){
 await store.db.run("INSERT INTO memory_history_append(memory_id,at,by,before_json,after_json,reason) VALUES (?,1,'import-history',NULL,?,?)",row.id,historyJson(row),reason);
}
async function approve(store:MemoryStore,rules:RuleService,id:number){
 const p=await rules.propose({id,expectedVersion:await store.revision(id),expectedBindingRevision:0,requestId:crypto.randomUUID()});
 await rules.confirm({proposalId:p.id,payloadHash:p.payload_hash,requestId:crypto.randomUUID()});
}
async function stable(store:MemoryStore,rules:RuleService,rows:MemoryRow[]){
 return {rows:await Promise.all(rows.map(r=>store.get(r.id))),revisions:await Promise.all(rows.map(r=>store.revision(r.id))),bindings:await rules.list(),rules:await rules.read(),render:compileRules(await rules.read())};
}
it("real initialize upgrades populated 14a9465 tables, preserving approved rules while historical append remains protected",async()=>{
 const stub=env.THREAD.getByName("owner");
 let frozen:unknown;
 await runInDurableObject(stub,async(instance,state)=>{
  const db=new DurableObjectSqliteDatabase(state.storage);
  await db.exec(LEGACY_MEMORY_SCHEMA+MEMORY_SUPPORT_SCHEMA+MEMORY_LIFECYCLE_TRIGGERS+LEGACY_MEMORY_RULE_SCHEMA);
  const store=new MemoryStore(db,"owner"),rules=new RuleService(store,"private:10000001");
  const rows:MemoryRow[]=[];
  for(const author of ["dashboard","qq:10000001"]){
   const row=(await store.remember({kind:"rule",text:"批准的合成规则 "+author,author})).row;
   // Exact old insert-then-label protocol, before approval; populate existing import mappings/receipts.
   const afterJson=historyJson(row);
   const inserted=await db.get<{id:number}>("INSERT INTO memory_versions(memory_id,at,by,after_json,reason) VALUES (?,1,'archive',?,'archive') RETURNING id",row.id,afterJson);
   await db.run("INSERT INTO memory_imported_versions VALUES (?)",inserted!.id);
   await db.run("INSERT INTO memory_history_map VALUES ('upgrade-history','owner',?,?)",row.id,row.id);
   await db.run("INSERT INTO memory_history_receipts VALUES ('upgrade-history','owner','memory',?,?,1)",String(row.id),sha256(JSON.stringify(row)));
   await approve(store,rules,row.id);rows.push((await store.get(row.id))!);
  }
  expect(await db.get("SELECT name FROM sqlite_master WHERE name='memory_history_append'")).toBeUndefined();
  const before=await stable(store,rules,rows);
  await instance.syncAdminView("owner"); // actual ThreadDO.initialize, not merely executing the new schema in the test
  expect(await db.get("SELECT name FROM sqlite_master WHERE name='memory_history_append'")).toBeTruthy();
  expect(await stable(store,rules,rows)).toEqual(before);
  await appendHistory(store,rows[0]!,"rule_approved");
  expect(await stable(store,rules,rows)).toEqual(before);
  for(const row of rows){
   await expect(store.update(row.id,{due_at:null},"qq:10000001")).rejects.toThrow("memory_rule:protected");
   await expect(store.update(row.id,{done_at:null},"dashboard")).rejects.toThrow("memory_rule:protected");
   await expect(db.run("INSERT INTO memory_versions(memory_id,at,by,after_json,reason) VALUES (?,1,'import-history',?,'import_history_current')",row.id,JSON.stringify(row))).rejects.toThrow("memory_rule:protected");
  }
  expect(await stable(store,rules,rows)).toEqual(before);frozen=await snapshot(store);
 });
 await evictDurableObject(stub);await stub.syncAdminView("owner");
 await runInDurableObject(stub,async(_instance,state)=>expect(await snapshot(new MemoryStore(new DurableObjectSqliteDatabase(state.storage),"owner"))).toEqual(frozen));
});
it("memory_history_append rolls back labels and versions atomically on failure",async()=>{
 const stub=env.THREAD.getByName("owner");await stub.syncAdminView("owner");
 await runInDurableObject(stub,async(_instance,state)=>{
  const store=new MemoryStore(new DurableObjectSqliteDatabase(state.storage),"owner"),rules=new RuleService(store,"private:10000001");
  const row=(await store.remember({kind:"rule",text:"混合批次已批准规则",author:"dashboard"})).row;await approve(store,rules,row.id);
  const before=await snapshot(store),approved=await stable(store,rules,[row]);
  await store.db.exec("CREATE TRIGGER test_history_failure BEFORE INSERT ON memory_versions WHEN new.reason='fault' BEGIN SELECT RAISE(ABORT,'synthetic_history_failure'); END;");
  // A single view statement cannot leave an orphan label if insertion fails.
  await expect(appendHistory(store,row,"fault")).rejects.toThrow("synthetic_history_failure");
  expect(await snapshot(store)).toEqual(before);
  await store.db.exec("DROP TRIGGER test_history_failure");
  await appendHistory(store,row,"archive");
  expect(await stable(store,rules,[row])).toEqual(approved);
  expect(await store.db.all("SELECT * FROM memory_imported_versions")).toHaveLength(1);
 });
});
it("historical labels cannot hide current versions, promote historical content or resurrect revoked approval",async()=>{
 const stub=env.THREAD.getByName("owner");await stub.syncAdminView("owner");
 await runInDurableObject(stub,async(_instance,state)=>{
  const store=new MemoryStore(new DurableObjectSqliteDatabase(state.storage),"owner"),rules=new RuleService(store,"private:10000001"),db=store.db;
  const row=(await store.remember({kind:"rule",text:"标签攻击合成规则",author:"dashboard"})).row;await approve(store,rules,row.id);
  await appendHistory(store,row);
  const current=await store.revision(row.id),historical=(await db.get<{version_id:number}>("SELECT version_id FROM memory_imported_versions"))!.version_id;
  const before=await snapshot(store);
  for(const sql of [
   "INSERT INTO memory_imported_versions VALUES ("+current+")",
   "INSERT INTO memory_imported_versions VALUES (-1)",
   "UPDATE memory_imported_versions SET version_id="+current,
   "DELETE FROM memory_imported_versions",
   "UPDATE memory_versions SET id=99999 WHERE id="+historical,
   "UPDATE memory_versions SET after_json='{}' WHERE id="+historical,
   "DELETE FROM memory_versions WHERE id="+historical,
   "INSERT OR REPLACE INTO memory_versions(id,memory_id,at,by,after_json) VALUES ("+historical+","+row.id+",1,'dashboard','{}')",
  ])await expect(db.run(sql)).rejects.toThrow("memory_history:");
  for(const by of ["archive","import-history","dashboard"])
   await expect(db.run("INSERT INTO memory_versions(memory_id,at,by,after_json,reason) VALUES (?,1,?,?,'historical')",row.id,by,JSON.stringify(row))).rejects.toThrow("memory_rule:protected");
  await expect(rules.propose({id:row.id,expectedVersion:historical,expectedBindingRevision:1,requestId:"historical-not-current"})).rejects.toThrow();
  expect(await snapshot(store)).toEqual(before);
  await rules.revoke({id:row.id,expectedVersion:current,expectedBindingRevision:1,requestId:"revoke"});
  const revoked=await stable(store,rules,[row]);
  await appendHistory(store,row,"approved");
  expect(await stable(store,rules,[row])).toEqual(revoked);
  await store.update(row.id,{text:"撤销后允许普通更新"},"dashboard");
  expect((await store.get(row.id))!.text).toBe("撤销后允许普通更新");
 });
});

it("failed real initialization rolls back the forward trigger replacement and succeeds after eviction",async()=>{
 const stub=env.THREAD.getByName("owner");let before:unknown;
 await runInDurableObject(stub,async(instance,state)=>{
  const db=new DurableObjectSqliteDatabase(state.storage),store=new MemoryStore(db,"owner"),rules=new RuleService(store,"private:10000001");
  await db.exec(LEGACY_MEMORY_SCHEMA+MEMORY_SUPPORT_SCHEMA+MEMORY_LIFECYCLE_TRIGGERS+LEGACY_MEMORY_RULE_SCHEMA);
  const row=(await store.remember({kind:"rule",text:"升级失败保留批准",author:"dashboard"})).row;await approve(store,rules,row.id);
  before=await snapshot(store);
  const trigger=await db.get("SELECT sql FROM sqlite_master WHERE name='memory_rule_protect_version_insert'");
  await db.exec("CREATE TABLE inbound(message_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,text TEXT NOT NULL,received_at INTEGER NOT NULL,status TEXT NOT NULL); INSERT INTO inbound VALUES ('old','10000001','synthetic',0,'done'); CREATE TRIGGER test_initialize_failure BEFORE UPDATE ON inbound BEGIN SELECT RAISE(ABORT,'synthetic_initialize_failure'); END;");
  await expect(instance.syncAdminView("owner")).rejects.toThrow("synthetic_initialize_failure");
  expect(await snapshot(store)).toEqual(before);
  expect(await db.get("SELECT sql FROM sqlite_master WHERE name='memory_rule_protect_version_insert'")).toEqual(trigger);
  expect(await db.get("SELECT name FROM sqlite_master WHERE name='memory_history_append'")).toBeUndefined();
  await db.exec("DROP TRIGGER test_initialize_failure");
 });
 await evictDurableObject(stub);await stub.syncAdminView("owner");
 await runInDurableObject(stub,async(_instance,state)=>{
  const db=new DurableObjectSqliteDatabase(state.storage);
  expect(await snapshot(new MemoryStore(db,"owner"))).toEqual(before);
  expect(await db.get("SELECT name FROM sqlite_master WHERE name='memory_history_append'")).toBeTruthy();
 });
});

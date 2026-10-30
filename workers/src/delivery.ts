import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { digest } from "./grants";
import type { Target } from "./policy";

const strict = { additionalProperties: false };
export const DeliverySourceSchema = Type.Object({ thread: Type.String({ pattern: "^(owner|(group|private):[1-9][0-9]{0,19})$" }),
  inputId: Type.String({ minLength: 1, maxLength: 200 }), generation: Type.Integer({ minimum: 0 }), scope: Type.String({ pattern: "^(group|private):[1-9][0-9]{0,19}$" }) }, strict);
export type DeliverySource = Static<typeof DeliverySourceSchema>;
export const DeliveryAssetSchema = Type.Object({ id: Type.String({ minLength: 1, maxLength: 200 }), scope: Type.String({ minLength: 1, maxLength: 100 }),
  sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }), bytes: Type.Integer({ minimum: 0 }), mime: Type.String({ minLength: 1, maxLength: 200 }),
  name: Type.String({ minLength: 1, maxLength: 200 }), kind: Type.Union([Type.Literal("image"),Type.Literal("file"),Type.Literal("audio"),Type.Literal("video")]) }, strict);
export type DeliveryAsset = Static<typeof DeliveryAssetSchema>;
export const SystemIntentSchema = Type.Object({ id: Type.String({ minLength: 1, maxLength: 500 }), operationAt:Type.Integer({minimum:0}), runId: Type.String({ minLength: 1, maxLength: 500 }),
  target: Type.Union([Type.Object({ kind: Type.Literal("private"), userId: Type.String({ pattern: "^[1-9][0-9]{0,19}$" }) },strict),
    Type.Object({ kind: Type.Literal("group"), groupId: Type.String({ pattern: "^[1-9][0-9]{0,19}$" }) },strict)]),
  text: Type.String({ maxLength: 4000 }), atUserId: Type.Optional(Type.String({ pattern: "^[1-9][0-9]{0,19}$" })),
  attachments: Type.Optional(Type.Array(DeliveryAssetSchema,{maxItems:10})), purpose:Type.Optional(Type.Literal("owner_alert")), source: Type.Optional(DeliverySourceSchema),
}, strict);
export type SystemQqIntent = Static<typeof SystemIntentSchema>;
export type AuthorizedQqIntent = SystemQqIntent & { source: DeliverySource };
export type DeliveryState = "queued" | "sending" | "sent" | "unknown" | "failed" | "rejected";
export type Delivery = { id: string; state: DeliveryState; payloadHash: string; createdAt: number; updatedAt: number; messageId?: string; error?: string };
type Row = { id: string; state: DeliveryState; payload_hash: string; payload_json: string; created_at: number; updated_at: number; message_id: string | null; error: string | null; echo: string | null; connection_id: string | null; mention: number; started_at:number|null; sender_id:string|null; operation_at:number };
export type StoredDelivery = { receipt: Delivery; intent: SystemQqIntent|null; echo: string | null; connectionId: string | null; mention: boolean; attemptedAt:number|null; senderId:string|null };

/** 正文保留 30 天、总账最多 5000 项；回收墓碑时推进拒绝水位，禁止旧操作重新入队。 */
export class DeliveryStore {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS delivery_intents(id TEXT PRIMARY KEY,state TEXT NOT NULL,payload_hash TEXT NOT NULL,payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,message_id TEXT,error TEXT,echo TEXT UNIQUE,connection_id TEXT,mention INTEGER NOT NULL DEFAULT 0,started_at INTEGER,sender_id TEXT,operation_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS delivery_state ON delivery_intents(state,created_at);
      CREATE INDEX IF NOT EXISTS delivery_created_at ON delivery_intents(created_at);
      CREATE INDEX IF NOT EXISTS delivery_state_operation_at ON delivery_intents(state,operation_at);
      CREATE INDEX IF NOT EXISTS delivery_operation_at ON delivery_intents(operation_at);
      CREATE INDEX IF NOT EXISTS delivery_updated_at ON delivery_intents(updated_at);
      CREATE TABLE IF NOT EXISTS delivery_meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS delivery_mentions(run_id TEXT NOT NULL,scope TEXT NOT NULL,intent_id TEXT NOT NULL,PRIMARY KEY(run_id,scope));`);
    const columns=storage.sql.exec<{name:string}>("PRAGMA table_info(delivery_intents)").toArray().map(row=>row.name);
    if(!columns.includes("started_at"))storage.sql.exec("ALTER TABLE delivery_intents ADD COLUMN started_at INTEGER");
    if(!columns.includes("sender_id"))storage.sql.exec("ALTER TABLE delivery_intents ADD COLUMN sender_id TEXT");
    if(!storage.sql.exec("SELECT key FROM delivery_meta WHERE key='count'").toArray().length)storage.sql.exec("INSERT INTO delivery_meta(key,value) SELECT 'count',COUNT(*) FROM delivery_intents");
    storage.sql.exec("UPDATE delivery_intents SET state='unknown',error='bridge_restarted',updated_at=? WHERE state='sending'", Date.now());
  }
  create(intent: SystemQqIntent, now=Date.now()): StoredDelivery {
    if (!Check(SystemIntentSchema,intent) || !intent.text.trim() && !intent.attachments?.length) throw new Error("invalid_delivery");
    const hash=digest({runId:intent.runId,target:intent.target,text:intent.text,atUserId:intent.atUserId??null,attachments:intent.attachments??[],source:intent.source??null,operationAt:intent.operationAt,purpose:intent.purpose??null});
    const before=this.get(intent.id);
    if(before){if(before.receipt.payloadHash!==hash)throw new Error("delivery_payload_conflict");return before;}
    if(intent.operationAt<=Math.max(now-30*86400000,this.meta("minimumOperationAt"))||intent.operationAt>now+300000)throw new Error("delivery_operation_expired");
    if(this.meta("count")>=5000)this.prune(now,true);
    if(intent.operationAt<=this.meta("minimumOperationAt"))throw new Error("delivery_operation_expired");
    if(this.meta("count")>=5000)throw new Error("delivery_capacity");
    if(this.storage.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM delivery_intents WHERE state IN ('queued','sending')").one().n>=200)throw new Error("delivery_queue_full");
    this.storage.transactionSync(()=>{
      this.storage.sql.exec("INSERT INTO delivery_intents(id,state,payload_hash,payload_json,created_at,updated_at,operation_at) VALUES (?,'queued',?,?,?,?,?)",intent.id,hash,JSON.stringify(intent),now,now,intent.operationAt);
      this.storage.sql.exec("UPDATE delivery_meta SET value=value+1 WHERE key='count'");
    });
    return this.required(intent.id);
  }
  get(id:string):StoredDelivery|undefined {
    const row=this.storage.sql.exec<Row>("SELECT * FROM delivery_intents WHERE id=?",id).toArray()[0];
    if(!row)return;
    const value:unknown=JSON.parse(row.payload_json);if(value!==null&&!Check(SystemIntentSchema,value))throw new Error("invalid_stored_delivery");
    return {receipt:{id:row.id,state:row.state,payloadHash:row.payload_hash,createdAt:row.created_at,updatedAt:row.updated_at,
      ...(row.message_id?{messageId:row.message_id}:{}),...(row.error?{error:row.error}:{})},intent:value,echo:row.echo,connectionId:row.connection_id,mention:row.mention===1,attemptedAt:row.started_at,senderId:row.sender_id};
  }
  required(id:string):StoredDelivery {const value=this.get(id);if(!value)throw new Error("delivery_not_found");return value;}
  list(input:{state?:DeliveryState;limit?:number}={}):Delivery[] {
    const limit=Math.min(200,Math.max(1,input.limit??50));
    const rows=input.state?this.storage.sql.exec<{id:string}>("SELECT id FROM delivery_intents WHERE state=? ORDER BY created_at DESC,id LIMIT ?",input.state,limit)
      :this.storage.sql.exec<{id:string}>("SELECT id FROM delivery_intents ORDER BY created_at DESC,id LIMIT ?",limit);
    return rows.toArray().map(row=>this.required(row.id).receipt);
  }
  begin(id:string,echo:string,connectionId:string,target:Target,senderId?:string):StoredDelivery {
    return this.storage.transactionSync(()=>{
      const stored=this.required(id);if(stored.receipt.state!=="queued")return stored;
      let mention=false;
      if(target.kind==="group"&&stored.intent?.atUserId){
        mention=this.storage.sql.exec("INSERT OR IGNORE INTO delivery_mentions(run_id,scope,intent_id) VALUES (?,?,?) RETURNING intent_id",stored.intent.runId,`group:${target.groupId}`,id).toArray().length===1;
      }
      this.storage.sql.exec("UPDATE delivery_intents SET state='sending',echo=?,connection_id=?,mention=?,updated_at=?,started_at=?,sender_id=? WHERE id=? AND state='queued'",echo,connectionId,mention?1:0,Date.now(),Date.now(),senderId??null,id);
      return this.required(id);
    });
  }
  settle(id:string,state:Exclude<DeliveryState,"queued"|"sending">,messageId?:string,error?:string):Delivery {
    const stored=this.required(id);
    if(stored.receipt.state==="sent")return stored.receipt;
    this.storage.sql.exec("UPDATE delivery_intents SET state=?,message_id=?,error=?,updated_at=? WHERE id=?",state,messageId??null,error?.slice(0,200)??null,Date.now(),id);
    if(state==="failed")this.storage.sql.exec("DELETE FROM delivery_mentions WHERE intent_id=?",id);
    return this.required(id).receipt;
  }
  byEcho(echo:string):StoredDelivery|undefined {const row=this.storage.sql.exec<{id:string}>("SELECT id FROM delivery_intents WHERE echo=?",echo).toArray()[0];return row?this.get(row.id):undefined;}
  private meta(key:string):number{return this.storage.sql.exec<{value:number}>("SELECT value FROM delivery_meta WHERE key=?",key).toArray()[0]?.value??0;}
  stats(){return {count:this.meta("count"),minimumOperationAt:this.meta("minimumOperationAt"),maxRecords:5000,bodyDays:30,tombstoneDays:90,maxQueued:200};}
  /** 每次最多处理 100 行；回收 ID 前推进持久拒绝水位，旧操作不能重新入队。 */
  prune(now=Date.now(),capacity=false):{removed:number;compacted:number;expired:number}{
    return this.storage.transactionSync(()=>{
      const expired=this.storage.sql.exec<{id:string}>("SELECT id FROM delivery_intents WHERE state='queued' AND operation_at<? ORDER BY operation_at,id LIMIT 100",now-30*86400000).toArray();
      for(const row of expired)this.storage.sql.exec("UPDATE delivery_intents SET state='rejected',payload_json='null',error='delivery_operation_expired',updated_at=? WHERE id=?",now,row.id);
      const rows=(capacity?this.storage.sql.exec<{id:string;operation_at:number}>("SELECT id,operation_at FROM delivery_intents WHERE state IN ('sent','failed','rejected','unknown') ORDER BY operation_at,id LIMIT ?",100-expired.length):this.storage.sql.exec<{id:string;operation_at:number}>("SELECT id,operation_at FROM delivery_intents WHERE state IN ('sent','failed','rejected','unknown') AND operation_at<? ORDER BY operation_at,id LIMIT ?",now-90*86400000,100-expired.length)).toArray();
      let floor=this.meta("minimumOperationAt");
      for(const row of rows){floor=Math.max(floor,row.operation_at);this.storage.sql.exec("DELETE FROM delivery_mentions WHERE intent_id=?",row.id);this.storage.sql.exec("DELETE FROM delivery_intents WHERE id=?",row.id);}
      if(rows.length){
        this.storage.sql.exec("UPDATE delivery_meta SET value=value-? WHERE key='count'",rows.length);
        this.storage.sql.exec("INSERT INTO delivery_meta(key,value) VALUES ('minimumOperationAt',?) ON CONFLICT(key) DO UPDATE SET value=MAX(value,excluded.value)",floor);
      }
      const compact=this.storage.sql.exec<{id:string}>("SELECT id FROM delivery_intents WHERE state IN ('sent','failed','rejected','unknown') AND operation_at<? AND payload_json!='null' ORDER BY operation_at,id LIMIT ?",now-30*86400000,100-rows.length-expired.length).toArray();
      for(const row of compact)this.storage.sql.exec("UPDATE delivery_intents SET payload_json='null',echo=NULL,connection_id=NULL,error=CASE WHEN state='unknown' THEN 'delivery_evidence_expired' ELSE error END WHERE id=?",row.id);
      return {removed:rows.length,compacted:compact.length,expired:expired.length};
    });
  }
  cancelQueued(input:{thread:string;generation:number}):number {
    let n=0;
    for(const row of this.storage.sql.exec<{id:string}>("SELECT id FROM delivery_intents WHERE state='queued'").toArray()){
      const stored=this.required(row.id);if(stored.intent?.source?.thread===input.thread&&stored.intent?.source?.generation===input.generation){this.settle(row.id,"rejected",undefined,"session_generation_revoked");n++;}
    }
    return n;
  }
}

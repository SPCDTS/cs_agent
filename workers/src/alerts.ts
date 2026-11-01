import type { AdminCursor } from "./admin/pagination";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { OpsSettings } from "./settings";

export const AlertKindSchema = Type.Union([Type.Literal("model_auth"),Type.Literal("model_failures"),Type.Literal("qq_disconnect")]);
export const AlertInputSchema = Type.Object({ kind: AlertKindSchema, scope: Type.String({ minLength: 1, maxLength: 100 }),
  episode: Type.String({ minLength: 1, maxLength: 200 }), origin: Type.Union([Type.Literal("qq"),Type.Literal("web")]),
  message: Type.String({ minLength: 1, maxLength: 1000 }) }, { additionalProperties: false });
export type AlertInput = Static<typeof AlertInputSchema>;
export type AlertView = AlertInput & { id: string; createdAt: number; updatedAt: number; closedAt: number | null; notifiedAt: number | null; deliveryId: string | null; status: string };
type AlertRow = { id:string; kind:AlertInput["kind"]; scope:string; episode:string; origin:AlertInput["origin"]; message:string; created_at:number; updated_at:number; closed_at:number|null; notified_at:number|null; delivery_id:string|null; status:string };
export type TurnReport = { scope:string; origin:"qq"|"web"; outcome:"ok"|"failed"|"auth_failed" };

/** 告警 episode 和发送 ID 均持久化；网页来源只进入面板。 */
export class AlertStore {
  constructor(private readonly storage:DurableObjectStorage){
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS ops_alerts(id TEXT PRIMARY KEY,kind TEXT NOT NULL,scope TEXT NOT NULL,episode TEXT NOT NULL,origin TEXT NOT NULL,message TEXT NOT NULL,
      created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,closed_at INTEGER,notified_at INTEGER,delivery_id TEXT,status TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ops_alert_recent ON ops_alerts(updated_at DESC,id);
      CREATE INDEX IF NOT EXISTS ops_alert_active ON ops_alerts(origin,closed_at,created_at);
      CREATE INDEX IF NOT EXISTS ops_alert_close ON ops_alerts(kind,scope,origin,closed_at);
      CREATE TABLE IF NOT EXISTS ops_turn_failures(scope TEXT NOT NULL,origin TEXT NOT NULL,failures INTEGER NOT NULL,episode TEXT NOT NULL,PRIMARY KEY(scope,origin));
      CREATE TABLE IF NOT EXISTS ops_alert_throttle(key TEXT PRIMARY KEY,at INTEGER NOT NULL);`);
  }
  private view(row:AlertRow):AlertView{return {id:row.id,kind:row.kind,scope:row.scope,episode:row.episode,origin:row.origin,message:row.message,createdAt:row.created_at,updatedAt:row.updated_at,closedAt:row.closed_at,notifiedAt:row.notified_at,deliveryId:row.delivery_id,status:row.status};}
  private get(id:string):AlertView|undefined{const row=this.storage.sql.exec<AlertRow>("SELECT * FROM ops_alerts WHERE id=?",id).toArray()[0];return row?this.view(row):undefined;}
  list(limit=100,before?:AdminCursor):AlertView[]{
    const args=before?[before.at,before.at,before.id]:[];
    return this.storage.sql.exec<AlertRow>("SELECT * FROM ops_alerts"+(before?" WHERE updated_at<? OR (updated_at=? AND id>?)":"")+" ORDER BY updated_at DESC,id LIMIT ?",...args,Math.min(200,Math.max(1,limit))).toArray().map(row=>this.view(row));
  }
  record(input:AlertInput,now=Date.now()):AlertView{
    if(!Check(AlertInputSchema,input))throw new Error("invalid_alert");
    const id=JSON.stringify([input.kind,input.scope,input.origin,input.episode]);
    const inserted=this.storage.sql.exec(`INSERT OR IGNORE INTO ops_alerts(id,kind,scope,episode,origin,message,created_at,updated_at,status) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`,id,input.kind,input.scope,input.episode,input.origin,input.message,now,now,input.origin==="web"?"panel":"pending").toArray().length>0;
    if(inserted)this.storage.sql.exec("DELETE FROM ops_alerts WHERE id IN (SELECT id FROM ops_alerts WHERE id<>? ORDER BY closed_at IS NULL DESC,updated_at DESC,id LIMIT -1 OFFSET 499)",id);
    const row=this.get(id);if(!row)throw new Error("alert_not_found");return row;
  }
  close(kind:AlertInput["kind"],scope:string,origin:AlertInput["origin"],now=Date.now()):void{
    this.storage.sql.exec("UPDATE ops_alerts SET closed_at=?,updated_at=?,status=CASE WHEN status IN ('pending','panel') THEN 'resolved' ELSE status END WHERE kind=? AND scope=? AND origin=? AND closed_at IS NULL",now,now,kind,scope,origin);
  }
  recordTurn(input:TurnReport,now=Date.now()):void{
    if(input.outcome==="ok"){
      this.storage.sql.exec("DELETE FROM ops_turn_failures WHERE scope=? AND origin=?",input.scope,input.origin);
      this.close("model_auth",input.scope,input.origin,now);this.close("model_failures",input.scope,input.origin,now);return;
    }
    const previous=this.storage.sql.exec<{failures:number;episode:string}>("SELECT failures,episode FROM ops_turn_failures WHERE scope=? AND origin=?",input.scope,input.origin).toArray()[0];
    const failures=(previous?.failures??0)+1,episode=previous?.episode??crypto.randomUUID();
    this.storage.sql.exec("INSERT INTO ops_turn_failures(scope,origin,failures,episode) VALUES (?,?,?,?) ON CONFLICT(scope,origin) DO UPDATE SET failures=excluded.failures",input.scope,input.origin,failures,episode);
    if(input.outcome==="auth_failed")this.record({kind:"model_auth",scope:input.scope,origin:input.origin,episode,message:"模型鉴权失败，请在管理面板检查模型登录与凭据。"},now);
    if(failures>=3)this.record({kind:"model_failures",scope:input.scope,origin:input.origin,episode,message:`${input.scope} 连续三次回合失败，请在管理面板检查。`},now);
  }
  pending(settings:OpsSettings,now=Date.now()):AlertView[]{
    if(!settings.alertOwner)return [];
    return this.storage.sql.exec<AlertRow>("SELECT * FROM ops_alerts WHERE origin='qq' AND closed_at IS NULL AND status IN ('pending','queued','sending') ORDER BY created_at,id LIMIT 10").toArray().map(row=>this.view(row)).filter(row=>
      (row.deliveryId!==null||this.allowed(`${row.kind}:${row.scope}`,settings.alertThrottleMinutes*60000,now)&&this.allowed("owner",settings.ownerAlertThrottleMinutes*60000,now)));
  }
  claim(id:string,now=Date.now()):string{
    const row=this.get(id);if(!row)throw new Error("alert_not_found");
    if(row.deliveryId)return row.deliveryId;
    const deliveryId=`alert:${crypto.randomUUID()}`;
    this.storage.sql.exec("UPDATE ops_alerts SET delivery_id=?,updated_at=?,status='queued' WHERE id=?",deliveryId,now,id);
    for(const key of ["owner",`${row.kind}:${row.scope}`])this.storage.sql.exec("INSERT INTO ops_alert_throttle(key,at) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET at=excluded.at",key,now);
    return deliveryId;
  }
  settle(id:string,state:string,now=Date.now()):void{this.storage.sql.exec("UPDATE ops_alerts SET status=?,updated_at=?,notified_at=CASE WHEN ?='sent' THEN ? ELSE notified_at END WHERE id=?",state,now,state,now,id);}
  private allowed(key:string,delay:number,now:number):boolean{const at=this.storage.sql.exec<{at:number}>("SELECT at FROM ops_alert_throttle WHERE key=?",key).toArray()[0]?.at;return at===undefined||now-at>=delay;}
}

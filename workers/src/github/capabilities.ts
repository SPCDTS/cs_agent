import { GitHubAppClient, GitHubAppError, type GitHubAppSecrets } from "./app";
import type { CapabilityData } from "./capability-model";

export const CAPABILITY_TTL = 300_000;
type Target = {id:number;stamp:string};
type Cache = {data:CapabilityData|null; fetchedAt:number; lastAttemptAt:number; expiresAt:number; retryAt:number; error:string|null; failures:number; stamp:string};
/** Diagnostic cache only. This class cannot call authorization, invalidate or save a binding. */
export class GitHubCapabilities {
  private readonly client: GitHubAppClient;
  private readonly tasks = new Map<string,Promise<void>>();
  constructor(private readonly storage: DurableObjectStorage, private readonly secrets: GitHubAppSecrets, private readonly targets:()=>Target[]) {
    this.client = new GitHubAppClient(secrets);
    storage.sql.exec("CREATE TABLE IF NOT EXISTS github_capabilities (key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  }
  private identity() { return [this.secrets.GITHUB_APP_ID,this.secrets.GITHUB_APP_CLIENT_ID,this.secrets.GITHUB_APP_SLUG].join(":"); }
  private empty(stamp:string): Cache { return {data:null,fetchedAt:0,lastAttemptAt:0,expiresAt:0,retryAt:0,error:null,failures:0,stamp}; }
  private read(key:string,stamp:string):Cache {
    const row=this.storage.sql.exec<{value:string}>("SELECT value FROM github_capabilities WHERE key=?",key).toArray()[0];
    if(row) {const value=JSON.parse(row.value) as Cache;if(value.stamp===stamp)return value;}
    return this.empty(stamp);
  }
  private view(c:Cache) {
    const {stamp:_,failures:__,...rest}=c;
    return {...rest,status:c.error?"error" as const:!c.data?"never" as const:c.expiresAt>Date.now()?"fresh" as const:"stale" as const};
  }
  snapshot() {
    const identity=this.identity();
    return {app:this.view(this.read("app",identity)),installations:this.targets().map(t=>({installationId:t.id,read:this.view(this.read(String(t.id),identity+":"+t.stamp))}))};
  }
  async refresh(force=false) {
    const identity=this.identity(), targets=this.targets();
    // Bound storage to this App and currently connected installations.
    for(const row of this.storage.sql.exec<{key:string}>("SELECT key FROM github_capabilities").toArray())
      if(row.key!=="app"&&!targets.some(t=>String(t.id)===row.key))this.storage.sql.exec("DELETE FROM github_capabilities WHERE key=?",row.key);
    const work=(key:string,stamp:string,id?:number)=>{
      const existing=this.tasks.get(key);if(existing)return existing;
      const before=this.read(key,stamp),now=Date.now();
      if(now<before.retryAt || now-before.lastAttemptAt<30_000 || !force&&before.expiresAt>now)return Promise.resolve();
      const current=()=>this.identity()===identity && (id===undefined || this.targets().some(t=>t.id===id&&identity+":"+t.stamp===stamp));
      const task=(async()=>{
        let next:Cache;
        try {
          const data=await this.client.capabilities(id);
          next={data,fetchedAt:Date.now(),lastAttemptAt:now,expiresAt:Date.now()+CAPABILITY_TTL,retryAt:0,error:null,failures:0,stamp};
        } catch(error) {
          const failures=Math.min(before.failures+1,6);
          next={...before,lastAttemptAt:now,error:error instanceof GitHubAppError?error.code+(error.reason?":"+error.reason:""):"invalid_capabilities",
            failures,retryAt:Date.now()+Math.max(Math.min(60_000*2**(failures-1),900_000),error instanceof GitHubAppError?error.retryAfterMs??0:0)};
        }
        if(current())this.storage.sql.exec("INSERT OR REPLACE INTO github_capabilities VALUES(?,?)",key,JSON.stringify(next));
      })().finally(()=>this.tasks.delete(key));
      this.tasks.set(key,task);return task;
    };
    await Promise.all([work("app",identity),...targets.map(t=>work(String(t.id),identity+":"+t.stamp,t.id))]);
    return this.snapshot();
  }
}

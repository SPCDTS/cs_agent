import type { Env } from "../src/env";
import { env,reset,runInDurableObject } from "cloudflare:test";
import { afterEach,expect,it,vi } from "vitest";
import { GitHubAppClient } from "../src/github/app";
import { GitHubConnections } from "../src/github/connections";
afterEach(async()=>{vi.restoreAllMocks();await reset();});
const browser="a".repeat(64),user={id:7,login:"owner"},repos=[{id:42,name:"owner/repo"}];
function mocks(){
 const tokens={access:"synthetic-access",refresh:"synthetic-refresh",expiresAt:Date.now()+28800_000,refreshUntil:Date.now()+15897600_000};
 return {
 exchange:vi.spyOn(GitHubAppClient.prototype,"exchange").mockResolvedValue(tokens),
 discover:vi.spyOn(GitHubAppClient.prototype,"discover").mockResolvedValue({user,installations:[456]}),
 inspect:vi.spyOn(GitHubAppClient.prototype,"inspect").mockImplementation(async()=>({user,repositories:repos,expiresAt:Date.now()+600_000})),
 repositories:vi.spyOn(GitHubAppClient.prototype,"repositories").mockResolvedValue(repos),
 };
}
async function fixture(work:(c:GitHubConnections,ctx:DurableObjectState,api:ReturnType<typeof mocks>)=>Promise<void>){
 await runInDurableObject(env.EVENTS.getByName("main"),async(_i,ctx)=>{const api=mocks();await work(new GitHubConnections(ctx.storage,env as Env,()=>{}),ctx,api);});
}
const start=async(c:GitHubConnections,admin="admin")=>new URL((await c.start(admin,browser)).url).searchParams.get("state")!;
const complete=(c:GitHubConnections,state:string,admin="admin")=>c.complete(state,"code",admin,browser);
it("keeps fresh S256 verifiers server-side and consumes state with its verifier",()=>fixture(async(c,ctx,api)=>{
 const url=new URL((await c.start("admin",browser)).url),state=url.searchParams.get("state")!;
 const stored=ctx.storage.sql.exec<{verifier:string}>("SELECT verifier FROM github_connect_state").one().verifier;
 expect(stored).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(url.href).not.toContain(stored);
 const challenge=Buffer.from(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(stored))).toString("base64url");
 expect(url.searchParams.get("code_challenge")).toBe(challenge);expect(url.searchParams.get("code_challenge_method")).toBe("S256");
 expect(new URL((await c.start("admin",browser)).url).searchParams.get("code_challenge")).not.toBe(challenge);
 await complete(c,state);expect(api.exchange).toHaveBeenCalledWith("code",stored);
 expect(ctx.storage.sql.exec<{verifier:string}>("SELECT verifier FROM github_connect_state").toArray().some(r=>r.verifier===stored)).toBe(false);
 expect(JSON.stringify(c.snapshot())).not.toContain(stored);
}));
it("publishes only user/installation repository-ID intersection and revalidates both scopes",()=>fixture(async(c,_ctx,api)=>{
 api.repositories.mockResolvedValue([...repos,{id:99,name:"org/private"}]);
 api.inspect.mockResolvedValue({user,repositories:[...repos,{id:88,name:"owner/not-installed"}],expiresAt:Date.now()+600_000});
 await complete(c,await start(c));expect(c.snapshot().installations[0]?.repositories).toEqual(repos);
 expect(c.authorized(456,42)).toBe(true);expect(c.authorized(456,99)).toBe(false);expect(c.authorized(999,42)).toBe(false);
 await c.sync();expect(api.inspect).toHaveBeenCalledTimes(2);expect(api.repositories).toHaveBeenCalledTimes(2);
}));
it("expired persisted permission cannot execute or recover using only an App token",()=>fixture(async(c,ctx,api)=>{
 await complete(c,await start(c));
 const value=JSON.parse(ctx.storage.sql.exec<{value:string}>("SELECT value FROM github_installations").one().value);value.until=Date.now()-1;
 ctx.storage.sql.exec("UPDATE github_installations SET value=?",JSON.stringify(value));
 const recovered=new GitHubConnections(ctx.storage,env as Env,()=>{});expect(recovered.authorized(456,42)).toBe(false);
 expect(recovered.snapshot().installations[0]?.repositories).toEqual([]);
 api.inspect.mockRejectedValueOnce(new Error("denied"));await recovered.sync();expect(recovered.authorized(456,42)).toBe(false);expect(api.repositories).toHaveBeenCalledTimes(1);
}));
it("legacy single-connection records and pending state confer no authority or automatic migration",()=>fixture(async(c,ctx,api)=>{
 ctx.storage.sql.exec("CREATE TABLE github_app_connection(id INTEGER PRIMARY KEY,value TEXT)");
 ctx.storage.sql.exec("INSERT INTO github_app_connection VALUES(1,?)",JSON.stringify({installationId:456,repositories:repos,status:"active",authorizedUntil:Date.now()+600_000,userVerified:true}));
 ctx.storage.sql.exec("CREATE TABLE github_app_state(hash TEXT PRIMARY KEY,code_verifier TEXT)");
 ctx.storage.sql.exec("INSERT INTO github_app_state VALUES('old-state','old-verifier')");
 expect(c.snapshot().installations).toEqual([]);expect(c.authorized(456,42)).toBe(false);await c.sync();expect(api.repositories).not.toHaveBeenCalled();
 await expect(complete(c,"old-state")).rejects.toThrow("unauthorized");
}));
it("inaccessible user installation fails before App repository lookup and consumes once",()=>fixture(async(c,_ctx,api)=>{
 const state=await start(c);api.inspect.mockRejectedValueOnce(new Error("github_app_unauthorized"));
 await expect(complete(c,state)).rejects.toThrow("unauthorized");expect(api.repositories).not.toHaveBeenCalled();
 expect(c.snapshot().installations).toEqual([]);await expect(complete(c,state)).rejects.toThrow("unauthorized");expect(api.exchange).toHaveBeenCalledTimes(1);
}));
it("binds initiating admin/browser, consumes once and survives reconstruction",()=>fixture(async(c,ctx,api)=>{
 const state=await start(c,"admin-a");
 await expect(complete(c,state+"x","admin-a")).rejects.toThrow("unauthorized");
 await expect(complete(c,state,"admin-b")).rejects.toThrow("unauthorized");
 await expect(c.complete(state,"code","admin-a","b".repeat(64))).rejects.toThrow("unauthorized");expect(api.repositories).not.toHaveBeenCalled();
 await complete(c,state,"admin-a");await expect(complete(c,state,"admin-a")).rejects.toThrow("unauthorized");
 expect(new GitHubConnections(ctx.storage,env as Env,()=>{}).authorized(456,42)).toBe(true);
 expect(ctx.storage.sql.exec("SELECT * FROM github_connect_state").toArray()).toEqual([]);
}));
it("bounds active state capacity and prunes expired state without reusing verifiers",()=>fixture(async(c,ctx)=>{
 for(let n=0;n<20;n++)await start(c);await expect(start(c)).rejects.toThrow("capacity");
 ctx.storage.sql.exec("UPDATE github_connect_state SET expires=0");await start(c);
 expect(ctx.storage.sql.exec("SELECT * FROM github_connect_state").toArray()).toHaveLength(1);
}));

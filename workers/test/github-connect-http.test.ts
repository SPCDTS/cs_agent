import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { exportPKCS8, generateKeyPair } from "jose";
import worker from "../src/index";
import { EventsDO } from "../src/events/do";
import type { Env } from "../src/env";
import { TokenVault } from "../src/mcp/crypto";

let pem:string;
beforeAll(async()=>{pem=await exportPKCS8((await generateKeyPair("RS256",{extractable:true})).privateKey);});
afterEach(async()=>{vi.unstubAllGlobals();vi.restoreAllMocks();await reset();});
const browser="a".repeat(64),secret="synthetic-app-webhook",storeKey="03".repeat(32);
const appEnv=()=>({...env,ADMIN_TOKEN:"synthetic-admin",GITHUB_MODE:"app" as const,GITHUB_APP_ID:"123",GITHUB_APP_SLUG:"test-events",GITHUB_APP_PRIVATE_KEY:pem,
 GITHUB_APP_WEBHOOK_SECRET:secret,GITHUB_APP_CLIENT_ID:"test-client",GITHUB_APP_CLIENT_SECRET:"synthetic-client-secret",
 GITHUB_APP_CALLBACK_URL:"https://test/admin/github/oauth/callback",GITHUB_APP_STORE_KEY:storeKey});
function mockGitHub() {
 const revoked=new Set<number>(),suspended=new Set<number>();let refreshes=0;
 const installs=(uid:number)=>uid===7?[456,789]:[999];
 const fetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=new URL(String(input)), token=new Headers(init?.headers).get("authorization")??"", uid=token.includes("access8")?8:7;
  const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
  if(url.hostname==="github.com"){
   const form=new URLSearchParams(String(init?.body)), id=(form.get("code")??form.get("refresh_token"))?.includes("8")?8:7;
   if(form.get("grant_type")==="refresh_token")refreshes++;
   return json({access_token:"access"+id,refresh_token:"refresh"+id,token_type:"bearer",expires_in:28800,refresh_token_expires_in:15897600});
  }
  if(url.pathname.startsWith("/user")&&revoked.has(uid))return json({error:"private-diagnostic"},401);
  if(url.pathname==="/user")return json({id:uid,login:"owner"+uid});
  const installation=(id:number)=>({id,app_id:123,suspended_at:suspended.has(id)?"2026-01-01":null});
  if(url.pathname==="/user/installations")return json({total_count:installs(uid).length,installations:installs(uid).map(installation)});
  const userRepo=/^\/user\/installations\/(\d+)\/repositories$/.exec(url.pathname);
  if(userRepo){const id=Number(userRepo[1]);return json({total_count:1,repositories:[{id:id+1,full_name:"owner/repo"+id}]});}
  const appInstallation=/^\/app\/installations\/(\d+)$/.exec(url.pathname);
  if(appInstallation)return json(installation(Number(appInstallation[1])));
  const issue=/^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
  if(issue)return json({token:"install"+issue[1],expires_at:new Date(Date.now()+3600_000).toISOString()});
  if(url.pathname==="/installation/repositories"){
   const id=Number(token.replace("Bearer install",""));
   return json({total_count:2,repositories:[{id:id+1,full_name:"owner/repo"+id},{id:99999,full_name:"org/not-user-visible"}]});
  }
  throw new Error("unexpected_mock_path");
 });
 vi.stubGlobal("fetch",fetcher);return {fetcher,revoked,suspended,get refreshes(){return refreshes;}};
}
async function harness(run:(e:Env,instance:EventsDO,ctx:DurableObjectState)=>Promise<void>) {
 await runInDurableObject(env.EVENTS.getByName("main"),async(_old,ctx)=>{
  const e=appEnv();const instance=new EventsDO(ctx,e);
  const routed={...e,EVENTS:{getByName:()=>instance} as unknown as Env["EVENTS"]};
  await run(routed,instance,ctx);
 });
}
async function admin(e:Env,path:string,value?:unknown,method="POST"){
 return worker.fetch(new Request("https://test/admin/github/"+path,{method,headers:{Authorization:"Bearer synthetic-admin","Content-Type":"application/json"},body:value===undefined?undefined:JSON.stringify(value)}),e);
}
async function connect(e:Env,code="code7"){
 const r=await admin(e,"connect/start",{browser});expect(r.status).toBe(200);
 const start=await r.json() as {url:string};const url=new URL(start.url),state=url.searchParams.get("state")!;
 expect(url.searchParams.get("code_challenge_method")).toBe("S256");
 const complete=await admin(e,"connect/complete",{browser,state,code});expect(complete.status).toBe(200);
 return {state,complete};
}
async function webhook(e:Env,payload:unknown,delivery:string,event="issues"){
 const body=JSON.stringify(payload),key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const signature=Buffer.from(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(body))).toString("hex");
 return worker.fetch(new Request("https://test/github/webhook",{method:"POST",body,headers:{"content-type":"application/json","x-github-delivery":delivery,"x-github-event":event,"x-hub-signature-256":"sha256="+signature}}),e);
}
const payload=(id=456,n=1)=>({installation:{id},repository:{id:id+1,full_name:"owner/repo"+id},action:"opened",issue:{number:n,title:"test"},sender:{id:7,login:"owner7"}});
async function enable(instance:EventsDO,ids=[456,789]){
 const current=(await instance.adminStatus()).github;
 expect((await instance.putGitHubConfig({...current.value,repositoryIds:ids.map(id=>({installationId:id,repositoryId:id+1}))},current.revision)).ok).toBe(true);
}

describe("production GitHub App HTTP and EventsDO integration",()=>{
 it("requires admin, binds PKCE to browser, expires and consumes state, and keeps callback URL inert",async()=>{
  mockGitHub();await harness(async(e,_i,ctx)=>{
   expect((await worker.fetch(new Request("https://test/admin/github/connections"),e)).status).toBe(401);
   const start=await (await admin(e,"connect/start",{browser})).json() as {url:string};
   const state=new URL(start.url).searchParams.get("state");
   expect((await admin(e,"connect/complete",{browser:"b".repeat(64),state,code:"code7"})).status).toBe(400);
   expect((await admin(e,"connect/complete",{browser,state,code:"code7"})).status).toBe(200);
   expect((await admin(e,"connect/complete",{browser,state,code:"code7"})).status).toBe(400);
   const expired=await (await admin(e,"connect/start",{browser})).json() as {url:string};
   ctx.storage.sql.exec("UPDATE github_connect_state SET expires=0");
   expect((await admin(e,"connect/complete",{browser,state:new URL(expired.url).searchParams.get("state"),code:"code7"})).status).toBe(400);
   const callback=await worker.fetch(new Request("https://test/admin/github/oauth/callback?state=x&code="+encodeURIComponent("</script><script>alert(1)</script>")),e);
   const html=await callback.text();expect(html).not.toContain("</script><script>");expect(callback.headers.get("referrer-policy")).toBe("no-referrer");
   expect(html).toContain("history.replaceState");expect(html).toContain("github-oauth-result");
  });
 });
 it("connects two identities without replacing installations, intersects repository IDs and encrypts every retained token",async()=>{
  mockGitHub();await harness(async(e,i,ctx)=>{
   await connect(e);await connect(e,"code8");
   const view=i.githubConnectionsView();expect(view.identities.map(u=>u.id)).toEqual([7,8]);expect(view.installations.map(b=>b.installationId)).toEqual([456,789,999]);
   expect(view.installations.every(b=>b.repositories.length===1)).toBe(true);
   const rows=JSON.stringify(ctx.storage.sql.exec("SELECT * FROM github_identities").toArray());
   for(const token of ["access7","refresh7","access8","refresh8"])expect(rows+JSON.stringify(view)).not.toContain(token);
   expect(JSON.stringify(view)).not.toContain("not-user-visible");
   await enable(i,[456,789,999]);
   expect((await webhook(e,payload(999),"other-owner")).status).toBe(202);
   expect(i.githubReceipt("other-owner")?.state).toBe("held");
   await admin(e,"connect/disconnect",{kind:"installation",id:456});
   expect(i.githubConnectionsView().installations.map(b=>b.installationId)).toEqual([789,999]);
  });
 });
 it("fails closed for unbound IDs and legacy config; shares lifecycle and business receipt dedupe and never revives backlog",async()=>{
  mockGitHub();await harness(async(e,i)=>{
   await connect(e);
   await webhook(e,payload(),"legacy-list");expect(i.githubReceipt("legacy-list")?.state).toBe("suppressed");
   await enable(i);
   await webhook(e,payload(456,2),"accepted");expect(i.githubReceipt("accepted")?.state).toBe("held");
   await webhook(e,payload(999),"unbound");expect(i.githubReceipt("unbound")?.reason).toBe("installation_not_authorized");
   const lifecycle={action:"suspend",installation:{id:456},sender:{id:7}};
   await webhook(e,lifecycle,"lifecycle","installation");
   expect(i.githubReceipt("accepted")?.state).toBe("suppressed");
   expect(i.githubConnectionsView().installations.find(b=>b.installationId===789)?.status).toBe("active");
   expect(await (await webhook(e,lifecycle,"changed-header","installation_repositories")).json()).toEqual({status:"body_duplicate"});
   await admin(e,"connect/sync",{userId:7});expect(i.githubConnectionsView().installations.find(b=>b.installationId===456)?.status).toBe("active");
   expect(i.githubReceipt("accepted")?.state).toBe("suppressed");
   await webhook(e,{action:"unsuspend",installation:{id:456}},"old-unsuspend","installation");
   expect(i.githubConnectionsView().installations.find(b=>b.installationId===456)?.status).toBe("revoked");
   expect((await webhook(e,payload(456,3),"lifecycle")).status).toBe(409);
  });
 });
 it("revokes all and only the matching identity, clears pending state, and rejects user token revocation on sync",async()=>{
  const gh=mockGitHub();await harness(async(e,i)=>{
   await connect(e);await connect(e,"code8");await enable(i,[456,789,999]);
   const start=await (await admin(e,"connect/start",{browser})).json() as {url:string};
   await webhook(e,{action:"revoked",sender:{id:7}},"revoke","github_app_authorization");
   expect(i.githubConnectionsView().identities.map(u=>u.id)).toEqual([8]);
   expect(i.githubConnectionsView().installations.filter(b=>b.user.id===7).every(b=>b.status==="revoked")).toBe(true);
   expect((await admin(e,"connect/complete",{browser,code:"code7",state:new URL(start.url).searchParams.get("state")})).status).toBe(400);
   gh.revoked.add(8);await admin(e,"connect/sync",{userId:8});
   expect(i.githubConnectionsView().identities).toEqual([]);
  });
 });
 it("single-flights rotating refresh, persists ciphertext, restores after reconstruction and preserves empty CAS config",async()=>{
  const gh=mockGitHub();await harness(async(e,i,ctx)=>{
   await connect(e);
   const row=ctx.storage.sql.exec<{value:string}>("SELECT value FROM github_identities WHERE id=7").one();
   const u=JSON.parse(row.value) as {id:number;generation:number;cipher:string};
   const vault=new TokenVault(storeKey),aad=JSON.stringify(["github-app-owner",u.id,u.generation]);
   const token=JSON.parse(await vault.decrypt(u.cipher,aad)) as {expiresAt:number};token.expiresAt=0;
   u.cipher=await vault.encrypt(JSON.stringify(token),aad);ctx.storage.sql.exec("UPDATE github_identities SET value=? WHERE id=7",JSON.stringify(u));
   await Promise.all([admin(e,"connect/sync",{userId:7}),admin(e,"connect/sync",{userId:7})]);expect(gh.refreshes).toBe(1);
   const current=(await i.adminStatus()).github;
   const results=await Promise.all([i.putGitHubConfig({...current.value,repositoryIds:[]},current.revision),i.putGitHubConfig({...current.value,repositoryIds:[]},current.revision)]);
   expect(results.filter(r=>r.ok)).toHaveLength(1);
   const recovered=new EventsDO(ctx,appEnv());expect((await recovered.adminStatus()).github.value.repositoryIds).toEqual([]);
   expect(recovered.githubConnectionsView().installations).toHaveLength(2);
   expect(JSON.stringify(recovered.githubConnectionsView())).not.toContain("access7");
  });
 });
});

it("accepts the App configuration ping without granting any installation and suppresses repository lifecycle independently",async()=>{
 mockGitHub();await harness(async(e,i)=>{
  expect((await webhook(e,{hook_id:1,zen:"test"},"app-ping","ping")).status).toBe(202);
  expect(i.githubConnectionsView().installations).toEqual([]);
  await connect(e);await enable(i);await webhook(e,payload(),"before-delete");
  await webhook(e,{action:"deleted",installation:{id:456},repository:{id:457}},"repo-delete","repository");
  expect(i.githubReceipt("before-delete")?.state).toBe("suppressed");
  expect(i.githubConnectionsView().installations.find(b=>b.installationId===789)?.status).toBe("active");
  const current=(await i.adminStatus()).github;
  expect((await i.putGitHubConfig({...current.value,repositoryIds:[{installationId:789,repositoryId:99999}]},current.revision)).ok).toBe(false);
 });
});
it("never lets an in-flight OAuth or refresh result resurrect a lifecycle-revoked identity",async()=>{
 const gh=mockGitHub();await harness(async(e,i)=>{
  const original=gh.fetcher.getMockImplementation()!;let revoke=true;
  gh.fetcher.mockImplementation(async(input,init)=>{
   if(new URL(String(input)).pathname==="/user"&&revoke){revoke=false;await webhook(e,{action:"revoked",sender:{id:7}},"during-oauth","github_app_authorization");}
   return original(input,init);
  });
  const start=await (await admin(e,"connect/start",{browser})).json() as {url:string};
  expect((await admin(e,"connect/complete",{browser,code:"code7",state:new URL(start.url).searchParams.get("state")})).status).toBe(400);
  expect(i.githubConnectionsView().identities).toEqual([]);
  await connect(e);
  revoke=true;
  gh.fetcher.mockImplementation(async(input,init)=>{
   if(new URL(String(input)).pathname==="/user"&&revoke){revoke=false;await webhook(e,{action:"revoked",sender:{id:7},nonce:1},"during-sync","github_app_authorization");}
   return original(input,init);
  });
  await admin(e,"connect/sync",{userId:7});
  expect(i.githubConnectionsView().identities).toEqual([]);
  expect(i.githubConnectionsView().installations.every(b=>b.status==="revoked")).toBe(true);
 });
});
it("fails closed on ciphertext identity substitution and never falls back to the installation scope",async()=>{
 mockGitHub();await harness(async(e,i,ctx)=>{
  await connect(e);await connect(e,"code8");
  const a=JSON.parse(ctx.storage.sql.exec<{value:string}>("SELECT value FROM github_identities WHERE id=7").one().value) as {cipher:string};
  const b=JSON.parse(ctx.storage.sql.exec<{value:string}>("SELECT value FROM github_identities WHERE id=8").one().value) as {cipher:string};
  b.cipher=a.cipher;ctx.storage.sql.exec("UPDATE github_identities SET value=? WHERE id=8",JSON.stringify(b));
  await admin(e,"connect/sync",{userId:8});
  expect(i.githubConnectionsView().identities.map(u=>u.id)).toEqual([7]);
  expect(i.githubConnectionsView().installations.find(b=>b.installationId===999)?.status).toBe("revoked");
 });
});

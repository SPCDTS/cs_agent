import type { Env } from "../src/env";
import { env } from "cloudflare:test";
import { vi } from "vitest";
import { GitHubInbox } from "../src/github/inbox";
import { GitHubConnections } from "../src/github/connections";

export const chosenRepository = [{installationId:456,repositoryId:42}];
/** Real OAuth/PKCE, encryption and installation intersection; mock only GitHub HTTPS responses. */
export async function installAppFixture() {
 const native=globalThis.fetch;
 const spy=vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{
  const url=new URL(typeof input==="string"?input:input instanceof URL?input.href:input.url);
  if(!["github.com","api.github.com"].includes(url.hostname)) return native(input,init);
  const json=(value:unknown)=>Response.json(value);
  if(url.pathname==="/login/oauth/access_token")return json({access_token:"fixture-access",refresh_token:"fixture-refresh",token_type:"bearer",expires_in:28800,refresh_token_expires_in:15897600});
  if(url.pathname==="/user")return json({id:7,login:"owner"});
  if(url.pathname==="/user/installations")return json({total_count:1,installations:[{id:456,app_id:123,suspended_at:null}]});
  if(url.pathname==="/app/installations/456")return json({id:456,app_id:123,suspended_at:null});
  if(url.pathname==="/app/installations/456/access_tokens")return json({token:"fixture-installation",expires_at:new Date(Date.now()+3600_000).toISOString()});
  if(url.pathname==="/installation/repositories"||url.pathname==="/user/installations/456/repositories")
   return json({total_count:1,repositories:[{id:42,full_name:"SPCDTS/cs_agent"}]});
  throw new Error("unexpected_github_fixture_endpoint");
 });
 try {
  const events=env.EVENTS.getByName("main"),browser="a".repeat(64);
  const start=await events.startGitHubConnect("fixture-admin",browser);
  await events.completeGitHubConnect(new URL(start.url).searchParams.get("state")!,"fixture-code","fixture-admin",browser);
  const current=(await events.adminStatus()).github;
  await events.putGitHubConfig({...current.value,repositoryIds:chosenRepository},current.revision);
 } finally {spy.mockRestore();}
}
export function appInbox(storage:DurableObjectStorage) {
 let inbox:GitHubInbox;
 const connections=new GitHubConnections(storage,env as Env,()=>inbox.reauthorize());
 inbox=new GitHubInbox(storage,{authorized:(installation,repo)=>connections.authorized(installation,repo),
  lifecycle:d=>{if(d.event==="github_app_authorization"&&d.lifecycleUserId)connections.disconnectUser(d.lifecycleUserId);else if(d.installationId)connections.invalidate(d.installationId);}});
 return inbox;
}

import { afterEach, expect, it, vi } from "vitest";
import { GitHubAppError } from "../src/github/app";
import { diagnoseConnect, type ConnectStage } from "../src/github/connect-diagnostics";
afterEach(()=>vi.restoreAllMocks());
it("never trusts message/code properties on foreign errors or non-allowlisted diagnostic labels",async()=>{
 const log=vi.spyOn(console,"error").mockImplementation(()=>{});
 const sensitive="synthetic-secret-with-query-and-headers";
 const result=await diagnoseConnect(sensitive,"complete",async mark=>{
  mark(sensitive as ConnectStage);
  throw {code:"unconfigured",message:sensitive,name:sensitive,stack:sensitive};
 });
 expect(result).toMatchObject({ok:false,status:500,code:"internal"});
 expect(log.mock.calls[0]?.[0]).toMatchObject({stage:"internal",status:500});
 expect(JSON.stringify([result,log.mock.calls])).not.toContain(sensitive);
});
it.each([["unconfigured",503],["unauthorized",400],["capacity",429],["rate_limited",429],["unavailable",502]] as const)(
 "classifies local %s errors without exporting their messages",async(code,status)=>{
 const log=vi.spyOn(console,"error").mockImplementation(()=>{}),requestId=crypto.randomUUID();
 const error=new GitHubAppError(code);error.message="synthetic-private-message";error.stack="synthetic-private-stack";
 const result=await diagnoseConnect(requestId,"complete",async mark=>{mark("token_exchange");throw error;});
 expect(result).toEqual({ok:false,status,code:"github_app_"+code,requestId});
 expect(JSON.stringify([result,log.mock.calls])).not.toContain("synthetic-private");
});

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import type { AdminRoute, AdminContext } from "./routes";
import { ownerIds } from "../policy";
import { MemoryEditorSchema } from "../memory/editor";
import { RuleError, type RuleProposeInput, type RuleConfirmInput, type RuleRevokeInput } from "../memory/rules";
const strict={additionalProperties:false} as const;
const revision=Type.Integer({minimum:0,maximum:Number.MAX_SAFE_INTEGER});
const id=Type.Integer({minimum:1,maximum:Number.MAX_SAFE_INTEGER});
const requestId=Type.String({pattern:"^[a-zA-Z0-9_-]{1,80}$"});
const propose=Type.Object({id,expectedVersion:revision,expectedBindingRevision:revision,entry:Type.Optional(MemoryEditorSchema),requestId},strict);
const confirm=Type.Object({proposalId:Type.String({pattern:"^[a-f0-9-]{36}$"}),payloadHash:Type.String({pattern:"^[a-f0-9]{64}$"}),requestId},strict);
const revoke=Type.Object({id,expectedVersion:revision,expectedBindingRevision:revision,requestId},strict);
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"Cache-Control":"no-store"}});
async function body(ctx:AdminContext,schema:TSchema) {
  const raw=await ctx.request.text();
  if(new TextEncoder().encode(raw).byteLength>8192)throw new RuleError("invalid");
  let value:unknown;try{value=JSON.parse(raw);}catch{throw new RuleError("invalid");}
  if(!Check(schema,value))throw new RuleError("invalid");
  return value;
}
function scope(ctx:AdminContext) {
  const value=ctx.url.searchParams.get("scope");
  if(ctx.url.searchParams.get("ns")!=="owner" || !value || !value.startsWith("private:") || !ownerIds(ctx.env).includes(value.slice(8)))throw new RuleError("scope");
  return value;
}
/** handleAdmin 先执行 Bearer 鉴权。只有管理操作能确认；不在模型/Code Mode 工具目录发布。 */
export function createRuleAdminRoutes():AdminRoute[] {
  const guard=(handle:AdminRoute["handle"]):AdminRoute["handle"]=>async ctx=>{
    try{return await handle(ctx);}catch(e){
      const code=e instanceof Error ? /^memory_rule:(invalid|conflict|scope|budget|integrity)$/.exec(e.message)?.[1] : undefined;
      if(code)return json({error:"memory_rule:"+code},code==="scope"?403:code==="conflict"?409:400);
      throw e;
    }
  };
  return [
    {method:"GET",path:"/admin/memory/rules/scopes",handle:async ctx=>json({scopes:ownerIds(ctx.env).map(id=>"private:"+id)})},
    {method:"GET",path:"/admin/memory/rules",handle:guard(async ctx=>json({bindings:await ctx.env.THREAD.getByName("owner").ruleList(scope(ctx))}))},
    {method:"GET",path:/^\/admin\/memory\/rules\/receipts\/(?<requestId>[a-zA-Z0-9_-]{1,80})$/,handle:guard(async ctx=>json(await ctx.env.THREAD.getByName("owner").ruleReceipt(scope(ctx),ctx.params.requestId!)))},
    {method:"POST",path:"/admin/memory/rules/proposals",handle:guard(async ctx=>json(await ctx.env.THREAD.getByName("owner").rulePropose(scope(ctx),await body(ctx,propose) as RuleProposeInput)))},
    {method:"POST",path:"/admin/memory/rules/confirm",handle:guard(async ctx=>json(await ctx.env.THREAD.getByName("owner").ruleConfirm(scope(ctx),await body(ctx,confirm) as RuleConfirmInput)))},
    {method:"POST",path:"/admin/memory/rules/revoke",handle:guard(async ctx=>json(await ctx.env.THREAD.getByName("owner").ruleRevoke(scope(ctx),await body(ctx,revoke) as RuleRevokeInput)))},
  ];
}

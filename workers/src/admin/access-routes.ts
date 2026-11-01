import { ADMIN_PAGE_SIZE, readAdminCursor, nextAdminCursor } from "./pagination";
import { Type, type TSchema, type Static } from "typebox";
import { Check } from "typebox/value";
import type { AdminRoute } from "./routes";
import { GrantInputSchema, GrantRevokeSchema, GrantImportSchema } from "../grants";
import { OpsSettingsSchema } from "../settings";
import { ownerIds } from "../policy";
import { parseSkill } from "../skills";

const strict={additionalProperties:false};
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"Cache-Control":"no-store"}});
async function read<T extends TSchema>(request:Request,schema:T):Promise<Static<T>>{
  const bytes=await request.arrayBuffer();if(bytes.byteLength>1048576)throw new Error("request_too_large");
  const value:unknown=JSON.parse(new TextDecoder().decode(bytes));if(!Check(schema,value))throw new Error("invalid_request");return value;
}
function protectedRoute(route:AdminRoute):AdminRoute{
  return {...route,handle:async context=>{
    try{return await route.handle(context);}catch(error){return json({error:error instanceof Error?error.message:"invalid_request"},400);}
  }};
}
/** 在统一管理鉴权之后注册；此工厂不开放任何 public 路径。 */
export function accessRoutes():AdminRoute[]{const routes:AdminRoute[]=[
  {method:"GET",path:"/admin/persona",handle:async({env})=>json(await env.REGISTRY.getByName("main").persona())},
  {method:"PUT",path:"/admin/persona",handle:async({env,request})=>{
    const input=await read(request,Type.Object({text:Type.String({maxLength:65536}),expected:Type.String({minLength:1,maxLength:100})},strict));
    const result=await env.REGISTRY.getByName("main").setPersona(input.text,input.expected);return json(result,result.ok?200:409);
  }},
  {method:"GET",path:"/admin/grants",handle:async({env})=>json({grants:await env.REGISTRY.getByName("main").grantsList()})},
  {method:"POST",path:"/admin/grants",handle:async({env,request})=>{
    const owner=ownerIds(env)[0];if(!owner)return json({error:"owner_required"},403);
    return json(await env.REGISTRY.getByName("main").grantPut(await read(request,GrantInputSchema),`qq:${owner}`));
  }},
  {method:"POST",path:"/admin/grants/revoke",handle:async({env,request})=>{
    const owner=ownerIds(env)[0];if(!owner)return json({error:"owner_required"},403);
    return json(await env.REGISTRY.getByName("main").grantRevoke(await read(request,GrantRevokeSchema),`qq:${owner}`));
  }},
  {method:"POST",path:"/admin/grants/import",handle:async({env,request})=>json(await env.REGISTRY.getByName("main").importGrants(await read(request,GrantImportSchema)))},
  {method:"GET",path:"/admin/ops-settings",handle:async({env})=>json(await env.REGISTRY.getByName("main").opsSettings())},
  {method:"PUT",path:"/admin/ops-settings",handle:async({env,request})=>{
    const input=await read(request,Type.Object({value:OpsSettingsSchema,expected:Type.String({minLength:1,maxLength:100})},strict));
    const result=await env.REGISTRY.getByName("main").putOpsSettings(input.value,input.expected);return json(result,result.ok?200:409);
  }},
  {method:"GET",path:"/admin/alerts",handle:async({env,url})=>{
    const rows=await env.REGISTRY.getByName("main").alerts(ADMIN_PAGE_SIZE+1,readAdminCursor(url));
    return json({alerts:rows.slice(0,ADMIN_PAGE_SIZE),next:nextAdminCursor(rows,row=>({at:row.updatedAt,id:row.id}))});
  }},
  {method:"GET",path:"/admin/deliveries",handle:async({env,url})=>{
    const rows=await env.BRIDGE.getByName("napcat").deliveryList({limit:ADMIN_PAGE_SIZE+1,before:readAdminCursor(url)});
    return json({deliveries:rows.slice(0,ADMIN_PAGE_SIZE),next:nextAdminCursor(rows,row=>({at:row.createdAt,id:row.id}))});
  }},
  {method:"GET",path:/^\/admin\/deliveries\/(?<id>.+)$/,handle:async({env,params})=>{
    const delivery=await env.BRIDGE.getByName("napcat").delivery(params.id!);return delivery?json(delivery):json({error:"not_found"},404);
  }},
  {method:"POST",path:/^\/admin\/deliveries\/(?<id>.+)\/reconcile$/,handle:async({env,params})=>json(await env.BRIDGE.getByName("napcat").reconcile(params.id!))},
  {method:"POST",path:/^\/admin\/skills\/(?<name>[^/]{1,128})\/publish$/,handle:async({env,params,request})=>{
    const input=await read(request,Type.Object({markdown:Type.String(),files:Type.Optional(Type.Record(Type.String(),Type.String())),expected:Type.String({minLength:1,maxLength:100})},strict));
    const result=await env.REGISTRY.getByName("main").skillPublish(parseSkill(params.name!,input.markdown,input.files),input.expected);return json(result,result.ok?200:409);
  }},
  {method:"GET",path:/^\/admin\/skills\/(?<name>[^/]{1,128})\/revision$/,handle:async({env,params})=>{
    const revision=await env.REGISTRY.getByName("main").skillRevision(params.name!);return revision?json({revision}):json({error:"not_found"},404);
  }},
];return routes.map(protectedRoute);}

import { Type,type Static,type TSchema } from "typebox";
import { Check } from "typebox/value";
import type { AdminRoute,AdminContext } from "./routes";
import type { WorkspaceAdminApi } from "../sandbox/admin";
const headers={"Cache-Control":"no-store","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff"};
const json=(value:unknown,status=200)=>Response.json(value,{status,headers});
async function body<T extends TSchema>(request:Request,schema:T):Promise<Static<T>>{
  const bytes=await request.arrayBuffer();if(bytes.byteLength>65536)throw new Error("request_too_large");
  const value:unknown=JSON.parse(new TextDecoder().decode(bytes));if(!Check(schema,value))throw new Error("invalid_request");return value;
}
/** 在现有handleAdmin鉴权后挂载；forThread仍需绑定经过核验的owner网页访问者。 */
export function workspaceRoutes(deps:{forThread(thread:string,context:AdminContext):Promise<WorkspaceAdminApi>}):AdminRoute[]{
  const base="/admin/threads/(?<thread>owner|group:[1-9][0-9]{0,15}|private:[1-9][0-9]{0,15})/workspace";
  const routes:AdminRoute[]=[
    {method:"GET",path:new RegExp(`^${base}$`),handle:async c=>json(await(await deps.forThread(c.params.thread!,c)).list())},
    {method:"GET",path:new RegExp(`^${base}/file$`),handle:async c=>{
      const file=await(await deps.forThread(c.params.thread!,c)).download({path:c.url.searchParams.get("path")??"",revision:c.url.searchParams.get("revision")??""});
      return new Response(file.bytes,{headers:{...headers,"Content-Type":"application/octet-stream","Content-Disposition":`attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`}});
    }},
    {method:"POST",path:new RegExp(`^${base}/reset-runtime$`),handle:async c=>json(await(await deps.forThread(c.params.thread!,c)).resetRuntime())},
    {method:"GET",path:new RegExp(`^${base}/children/(?<child>[A-Za-z0-9_-]{1,100})$`),handle:async c=>json(await(await deps.forThread(c.params.thread!,c)).inspectChild({childId:c.params.child!}))},
    {method:"POST",path:new RegExp(`^${base}/merge$`),handle:async c=>{
      const input=await body(c.request,Type.Object({childId:Type.String({minLength:1,maxLength:100}),expectedRevision:Type.String({minLength:1,maxLength:64}),sourceRevision:Type.String({minLength:1,maxLength:64}),paths:Type.Array(Type.String({minLength:1,maxLength:1024}),{minItems:1,maxItems:256})},{additionalProperties:false}));
      const result=await(await deps.forThread(c.params.thread!,c)).mergeChild(input);return json(result,result.ok?200:409);
    }},
  ];
  return routes.map(route=>({...route,handle:async c=>{
    try{return await route.handle(c);}catch(error){const code=error instanceof Error&&/^[a-z_]{1,80}$/.test(error.message)?error.message:"workspace_error";return json({error:code},/denied|owner|forbidden/.test(code)?403:400);}
  }}));
}

import type { Context } from "@earendil-works/chord/context";
import { Type } from "typebox";
import { defineExtension, defineTool, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Env } from "../env";
import { GrantInputSchema, GrantRevokeSchema } from "../grants";
import { scopeOf } from "../policy";

export type AccessDeps={
  /** 宿主重新核验 owner 私聊交互回合或鉴权 owner 网页，返回 secret 对应的真实 qq:<id> actor。 */
  allowManage(api:ToolExecutionApi,context:Context):Promise<string|undefined>;
  registry():Pick<ReturnType<Env["REGISTRY"]["getByName"]>,"edgeList"|"edgeSet"|"grantsList"|"grantPut"|"grantRevoke">;
  bridge():Pick<ReturnType<Env["BRIDGE"]["getByName"]>,"chats">;
};
const output=(value:unknown,isError=false):ToolExecutionResult=>({...(isError?{isError}:{}),output:[{type:"text",text:typeof value==="string"?value:JSON.stringify(value)}]});
export function createAccessExtension(host:AccessDeps){
  async function run(api:ToolExecutionApi,context:Context,work:(actor:string)=>Promise<unknown>):Promise<ToolExecutionResult>{
    try{
      const actor=await host.allowManage(api,context);
      if(!actor||!/^qq:[1-9][0-9]{0,19}$/.test(actor))return output("此工具仅限 owner 私聊交互回合或鉴权的 owner 网页；本轮请勿重试。",true);
      return output(await work(actor));
    }catch(error){
      const code=error instanceof Error&&/^[a-z_]{1,64}$/.test(error.message)?error.message:undefined;
      return output((code?code+"：":"")+"授权或聊天目录操作失败；请在管理面板核对权限与 QQ 连接。",true);
    }
  }
  return defineExtension({name:"cs.access",namespace:{name:"access",description:"QQ 授权、聊天目录和有向通信边"},tools:[
    defineTool({name:"edge_list",description:"列出部署基线、持久覆盖及有效有向边。",replay:"safe",parameters:Type.Object({},{additionalProperties:false}),
      execute:(_args,api,c)=>run(api,c,()=>host.registry().edgeList())}),
    ...(["allow","deny"] as const).map(decision=>defineTool({name:decision==="allow"?"edge_grant":"edge_revoke",description:decision==="allow"?"授予单向通信；反向需要另行授权。":"持久撤销单向通信，包括部署基线。",replay:"unsafe",
      parameters:Type.Object({from:Type.String(),to:Type.String()},{additionalProperties:false}),
      execute:({from,to},api,c)=>run(api,c,actor=>host.registry().edgeSet(from,to,decision,actor))})),
    defineTool({name:"qq_chats",description:"Owner only. List friends and groups the bot can message. Optional query filters names/IDs; limit defaults to 50 (max 100). This directory grants no send or read permission.",replay:"safe",
      parameters:Type.Object({query:Type.Optional(Type.String({maxLength:100})),limit:Type.Optional(Type.Integer({minimum:1,maximum:100})),refresh:Type.Optional(Type.Boolean())},{additionalProperties:false}),
      execute:(args,api,context)=>run(api,context,async()=>{
        const query=args.query?.trim().toLowerCase(),all=await host.bridge().chats(args.refresh??false);
        const matched=all.filter(chat=>!query||`${chat.name} ${scopeOf(chat.target)}`.toLowerCase().includes(query));
        return {total:matched.length,chats:matched.slice(0,args.limit??50).map(chat=>({...chat,address:`qq:${scopeOf(chat.target)}`}))};
      }),
    }),
    defineTool({name:"auth_list",description:"Owner only. List current grants, including expired grants; changes take effect immediately.",replay:"safe",parameters:Type.Object({},{additionalProperties:false}),
      execute:(_args,api,context)=>run(api,context,async()=>{const grants=await host.registry().grantsList();return {total:grants.length,grants:grants.slice(0,100)};}),
    }),
    defineTool({name:"auth_grant",description:"Owner only. Replace a user's send/schedule grant. Empty targets forbid proactive cross-chat sends; omitted scopes allow any source, an empty list allows none. expires_in_hours omitted means no expiry.",replay:"unsafe",parameters:GrantInputSchema,
      execute:(args,api,context)=>run(api,context,actor=>host.registry().grantPut(args,actor)),
    }),
    defineTool({name:"auth_revoke",description:"Owner only. Revoke selected capabilities immediately; omit caps to revoke all grants for that user.",replay:"unsafe",parameters:GrantRevokeSchema,
      execute:(args,api,context)=>run(api,context,actor=>host.registry().grantRevoke(args,actor)),
    }),
  ].map(tool=>({...tool,callers:["model","tools"] as const}))});
}

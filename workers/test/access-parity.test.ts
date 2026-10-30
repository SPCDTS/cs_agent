import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { DeliveryStore } from "../src/delivery";
import { AlertStore } from "../src/alerts";
import { defaultOpsSettings, threadOpsSettings } from "../src/settings";
import { accessRoutes } from "../src/admin/access-routes";
import { action,connect,reply } from "./helpers";

const sockets:WebSocket[]=[];
afterEach(async()=>{for(const socket of sockets.splice(0))socket.close();await reset();});
const target={kind:"private",userId:"10000003"} satisfies {kind:"private";userId:string};
const operationAt=Date.now();
const intent=(id:string,text="测试消息")=>({id,operationAt,runId:"run",target,text});
const registry=()=>env.REGISTRY.getByName("main");

describe("durable delivery parity",()=>{
  it("compacts old bodies and rejects reclaimed operation timestamps instead of resending",async()=>{
    const result=await runInDurableObject(env.BRIDGE.getByName("napcat"),(_instance,state)=>{
      const store=new DeliveryStore(state.storage),input=intent("retention");store.create(input);store.settle(input.id,"sent","receipt");
      const compact=store.prune(Date.now()+31*86400000),replay=store.create(input).receipt,body=store.get(input.id)?.intent;
      store.prune(Date.now()+31*86400000,true);
      let rejected=false;try{store.create(input);}catch(error){rejected=error instanceof Error&&error.message==="delivery_operation_expired";}
      return {compact,replay,body,rejected,count:store.stats().count};
    });
    expect(result).toMatchObject({compact:{compacted:1},replay:{state:"sent"},body:null,rejected:true,count:0});
  });
  it("records upload notices without triggering a model turn",async()=>{
    const {socket,frames}=await connect(sockets);
    socket.send(JSON.stringify({post_type:"notice",notice_type:"offline_file",self_id:10000000,user_id:10000001,time:1700000000,message_id:451,file:{id:"file-451",name:"中文.txt",size:10}}));
    await expect.poll(()=>runInDurableObject(env.THREAD.getByName("owner"),(_instance,state)=>state.storage.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM message_media WHERE message_id='451'").one().n)).toBe(1);
    expect(frames).toHaveLength(0);
    expect(await runInDurableObject(env.THREAD.getByName("owner"),(_instance,state)=>state.storage.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM inbound").one().n)).toBe(0);
  });
  it("resolves file IDs through read-only NapCat APIs and rejects local-only image paths",async()=>{
    const {socket,frames}=await connect(sockets),bridge=env.BRIDGE.getByName("napcat");
    const file=bridge.getFileUrl(target,"file-id");const frame=await action(frames,0,"get_private_file_url");
    socket.send(JSON.stringify({status:"ok",retcode:0,echo:frame.echo,data:{url:"https://files.example.test/a"}}));
    expect(await file).toBe("https://files.example.test/a");
    const image=bridge.getImage("image-id"),rejected=expect(async()=>await image).rejects.toThrow("media_url_unavailable");const imageFrame=await action(frames,0,"get_image");
    socket.send(JSON.stringify({status:"ok",retcode:0,echo:imageFrame.echo,data:{file:"C:/NapCat/cache.jpg"}}));await rejected;
  });
  it("replays an acknowledged intent, rejects payload conflicts and keeps one frame",async()=>{
    const {socket,frames}=await connect(sockets),bridge=env.BRIDGE.getByName("napcat");
    const first=bridge.systemDeliver(intent("same"));
    const frame=await action(frames,0,"send_private_msg");reply(socket,frame.echo);
    expect(await first).toMatchObject({id:"same",state:"sent",messageId:"90000001"});
    expect(await bridge.systemDeliver(intent("same"))).toMatchObject({state:"sent"});
    await expect(async()=>await bridge.systemDeliver(intent("same","冲突"))).rejects.toThrow("payload_conflict");
    expect(frames).toHaveLength(1);
  });
  it("persists sending before the frame, marks disconnect unknown, and accepts a late receipt",async()=>{
    const old=await connect(sockets),bridge=env.BRIDGE.getByName("napcat");
    const pending=bridge.systemDeliver(intent("uncertain"));
    const frame=await action(old.frames,0,"send_private_msg");
    expect(await bridge.delivery("uncertain")).toMatchObject({state:"sending"});
    await connect(sockets);
    expect(await pending).toMatchObject({state:"unknown"});
    expect(await bridge.systemDeliver(intent("uncertain"))).toMatchObject({state:"unknown"});
    // 持久 echo 足以结算迟到回执，不依赖内存中的 pending Promise。
    await runInDurableObject(bridge,async(instance,state)=>{
      const socket=state.getWebSockets().find(socket=>{const item:unknown=socket.deserializeAttachment();return item!==null&&typeof item==="object"&&"active"in item&&item.active===true;});
      if(!socket)throw new Error("missing socket");
      const attachment:unknown=socket.deserializeAttachment();if(!attachment||typeof attachment!=="object"||!("id"in attachment)||typeof attachment.id!=="string")throw new Error("missing attachment");
      state.storage.sql.exec("UPDATE delivery_intents SET connection_id=? WHERE id='uncertain'",attachment.id);
      await instance.webSocketMessage(socket,JSON.stringify({status:"ok",retcode:0,echo:frame.echo,data:{message_id:90000005}}));
    });
    expect(await bridge.delivery("uncertain")).toMatchObject({state:"sent",messageId:"90000005"});
  });
  it("mentions only the first confirmed or unknown group reply in a run",async()=>{
    const {socket,frames}=await connect(sockets),bridge=env.BRIDGE.getByName("napcat"),group={kind:"group",groupId:"200000001"} satisfies {kind:"group";groupId:string};
    const first=bridge.systemDeliver({...intent("mention-a","第一条"),target:group,atUserId:"10000003"});
    const second=bridge.systemDeliver({...intent("mention-b","第二条"),target:group,atUserId:"10000003"});
    const a=await action(frames,0);expect(a.params.message?.[0]).toMatchObject({type:"at"});reply(socket,a.echo);
    expect(await first).toMatchObject({state:"sent"});
    const b=await action(frames,1);expect(b.params.message?.some(segment=>segment.type==="at")).toBe(false);reply(socket,b.echo,90000002);
    expect(await second).toMatchObject({state:"sent"});
  });
  it("converts interrupted sending to unknown and preserves mention/terminal tombstones",async()=>{
    const result=await runInDurableObject(env.BRIDGE.getByName("napcat"),(_instance,state)=>{
      const store=new DeliveryStore(state.storage),group={kind:"group",groupId:"200000001"} satisfies {kind:"group";groupId:string};
      store.create({...intent("a"),target:group,atUserId:"10000003"});store.begin("a","echo-a","conn",group);
      const restored=new DeliveryStore(state.storage);
      restored.create({...intent("b"),target:group,atUserId:"10000003"});
      const next=restored.begin("b","echo-b","conn",group);
      restored.settle("b","sent","sent-b");
      return {first:restored.get("a")?.receipt,nextMention:next.mention,replayed:restored.create({...intent("b"),target:group,atUserId:"10000003"}).receipt};
    });
    expect(result).toMatchObject({first:{state:"unknown"},nextMention:false,replayed:{state:"sent"}});
  });
  it("rejects stale source permissions and keeps cancelled generations rejected",async()=>{
    await connect(sockets);const bridge=env.BRIDGE.getByName("napcat");
    const source={thread:"owner",inputId:"not-real",scope:"private:10000001",generation:0};
    expect(await bridge.deliver({...intent("spoof"),source})).toMatchObject({state:"rejected",error:"delivery_source_revoked"});
    await runInDurableObject(bridge,(_instance,state)=>{new DeliveryStore(state.storage).create({...intent("old"),source});});
    expect(await bridge.cancelQueued({thread:"owner",generation:0})).toEqual({cancelled:1});
    expect(await bridge.deliver({...intent("old"),source})).toMatchObject({state:"rejected",error:"session_generation_revoked"});
  });
  it("refuses ambiguous reconciliation and settles only a unique bot/target/time/content history match",async()=>{
    const {socket,frames}=await connect(sockets),bridge=env.BRIDGE.getByName("napcat");
    await runInDurableObject(bridge,async(_instance,state)=>{
      await state.storage.put("selfId","10000000");const store=new DeliveryStore(state.storage);store.create(intent("history"));store.begin("history","e","c",target,"10000000");store.settle("history","unknown");
    });
    const evidence={user_id:10000000,target_id:10000003,message_id:123,time:Math.floor(Date.now()/1000),message:[{type:"text",data:{text:"测试消息"}}]};
    const ambiguous=bridge.reconcile("history");let frame=await action(frames,0,"get_friend_msg_history");
    socket.send(JSON.stringify({status:"ok",retcode:0,echo:frame.echo,data:{messages:[evidence,{...evidence,message_id:124}]}}));
    expect(await ambiguous).toMatchObject({state:"unknown"});
    const unique=bridge.reconcile("history");frame=await action(frames,1,"get_friend_msg_history");
    socket.send(JSON.stringify({status:"ok",retcode:0,echo:frame.echo,data:{messages:[evidence]}}));
    expect(await unique).toMatchObject({state:"sent",messageId:"123"});
  });
});

describe("registry access and configuration",()=>{
  it("enforces caps/scope/targets/expiry immediately after revoke",async()=>{
    const r=registry(),user="qq:10000003";
    await r.grantPut({user,caps:["send","schedule"],targets:["qq:private:10000004"],scopes:["group:200000001"],expires_in_hours:1},"qq:10000001");
    expect(await r.canAccess({user,cap:"send",scope:"group:200000001",target:"qq:private:10000004"})).toBe(true);
    expect(await r.canAccess({user,cap:"send",scope:"private:10000003",target:"qq:private:10000004"})).toBe(false);
    expect(await r.canAccess({user,cap:"send",scope:"group:200000001",target:"qq:private:10000005"})).toBe(false);
    await r.grantRevoke({user,caps:["send"]},"qq:10000001");
    expect(await r.canAccess({user,cap:"send",scope:"group:200000001",target:"qq:private:10000004"})).toBe(false);
    expect(await r.canAccess({user,cap:"schedule",scope:"group:200000001"})).toBe(true);
    await expect(async()=>await r.grantPut({user,caps:["send"]},user)).rejects.toThrow("owner_required");
  });
  it("imports grants incrementally without extending timestamps or resurrecting revoked users",async()=>{
    const r=registry(),grant={user:"qq:10000003",caps:["send"],targets:[],expires_at:100,granted_by:"qq:10000001",created_at:10,updated_at:20};
    const input={datasetId:"legacy",sourceHash:"a".repeat(64),schemaVersion:1,dryRun:true,grants:[grant]};
    expect(await r.importGrants(input)).toMatchObject({items:[{action:"created"}]});expect(await r.grantsList()).toEqual([]);
    expect(await r.importGrants({...input,dryRun:false})).toMatchObject({items:[{action:"created"}]});
    expect(await r.grantsList()).toMatchObject([{created_at:10,expires_at:100,expired:true}]);
    await r.grantRevoke({user:grant.user},"qq:10000001");
    expect(await r.importGrants({...input,dryRun:false,sourceHash:"b".repeat(64)})).toMatchObject({items:[{action:"preserved"}]});expect(await r.grantsList()).toEqual([]);
    expect(await r.importGrants({...input,dryRun:false})).toMatchObject({replayed:true});
  });
  it("separates persona and ops CAS from runtime settings and detects skill ABA updates",async()=>{
    const r=registry(),initial=await r.persona();expect(initial).toEqual({text:"",revision:"0"});
    const saved=await r.setPersona("中文人格",initial.revision);expect(saved.ok).toBe(true);
    expect(await r.setPersona("过期",initial.revision)).toMatchObject({ok:false,conflict:{text:"中文人格"}});
    const runtime=await r.settings(),ops=await r.opsSettings();
    expect(await r.putOpsSettings({...ops.value,alertOwner:false,threads:{owner:{rawDays:1,consolidate:false}}},ops.revision)).toMatchObject({ok:true});
    expect((await r.settings()).revision).toBe(runtime.revision);
    expect(threadOpsSettings((await r.opsSettings()).value,"owner")).toMatchObject({rawDays:1,consolidate:false});
    const skill={name:"test",description:"说明",body:"---\nname: test\ndescription: 说明\n---\n内容"};
    expect(await r.skillPublish(skill,"absent")).toMatchObject({ok:true});const revision=await r.skillRevision("test");
    if(!revision)throw new Error("missing revision");await r.skillPut(skill);
    expect(await r.skillPublish(skill,revision)).toMatchObject({ok:false});
    expect(await r.skillPublish(skill,"absent")).toMatchObject({ok:false});
  });
  it("lists panel-only web alerts and persistently throttles owner delivery",async()=>{
    const result=await runInDurableObject(registry(),(_instance,state)=>{
      const store=new AlertStore(state.storage),settings=defaultOpsSettings({}),now=Date.now();
      for(let i=0;i<3;i++)store.recordTurn({scope:"owner",origin:"web",outcome:"failed"},now+i);
      store.recordTurn({scope:"owner",origin:"qq",outcome:"auth_failed"},now);
      const pending=store.pending(settings,now),first=pending[0];if(!first)throw new Error("missing alert");
      store.claim(first.id,now);store.settle(first.id,"sent",now);
      store.record({kind:"model_auth",scope:"group:200000001",origin:"qq",episode:"second",message:"鉴权错误"},now+1);
      return {list:store.list(),pending:store.pending(settings,now+1000),later:store.pending(settings,now+1800001)};
    });
    expect(result.list.some(row=>row.origin==="web"&&row.status==="panel")).toBe(true);
    expect(result.pending.filter(row=>row.deliveryId===null)).toEqual([]);
    expect(result.later.some(row=>row.scope==="group:200000001")).toBe(true);
  });
  it("keeps web failures panel-only and sends a QQ episode once",async()=>{
    const {socket,frames}=await connect(sockets),r=registry();
    for(let i=0;i<3;i++)await r.recordTurn({scope:"owner",origin:"web",outcome:"failed"});
    await r.opsTick();expect(frames).toHaveLength(0);
    await r.recordTurn({scope:"owner",origin:"qq",outcome:"auth_failed"});
    const tick=r.opsTick(),frame=await action(frames,0,"send_private_msg");reply(socket,frame.echo);await tick;
    expect(await r.alerts()).toEqual(expect.arrayContaining([expect.objectContaining({origin:"web",status:"panel"}),expect.objectContaining({origin:"qq",status:"sent"})]));
    await r.opsTick();expect(frames).toHaveLength(1);
  });
  it("exposes only authenticated admin route definitions and rejects invalid input",async()=>{
    const routes=accessRoutes();expect(routes.every(route=>!route.public)).toBe(true);
    const route=routes.find(route=>route.path==="/admin/persona"&&route.method==="PUT");if(!route)throw new Error("missing route");
    const request=new Request("https://test/admin/persona",{method:"PUT",body:JSON.stringify({text:"新人格",expected:"0"})});
    expect(await (await route.handle({env,request,url:new URL(request.url),params:{}})).json()).toMatchObject({ok:true});
  });
});

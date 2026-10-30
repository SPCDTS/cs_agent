import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { lookupHostMedia } from "../src/tools/media-host";
import { normalizeMessage } from "../src/policy";
import { event } from "./helpers";
afterEach(async()=>{await reset();});
function bridge() { return {getMessage:vi.fn(async()=>({})),getFileUrl:vi.fn(async()=>"https://cdn.example.com/file"),getImage:vi.fn(async()=>"https://cdn.example.com/image"),getRecord:vi.fn(async()=>"https://cdn.example.com/audio"),getFile:vi.fn(async()=>"https://cdn.example.com/video")}; }
it("按已核验来源解析fileId与图片引用，选择后才发RPC",async()=>{
  const input=normalizeMessage({...event(1),message:[{type:"file",data:{file_id:"report-id",name:"报告.pdf"}},{type:"image",data:{file:"image-key"}}]});if(!input)throw new Error("fixture");
  const thread=env.THREAD.getByName("private:10000003");await thread.ingest(input);
  await runInDurableObject(thread,async(_instance,state)=>{
    const database=new DurableObjectSqliteDatabase(state.storage),rpc=bridge(),source={scope:"private:10000003",namespace:"private:10000003",target:{kind:"private" as const,userId:"10000003"}};
    const files=await lookupHostMedia({database,bridge:rpc,source,messageId:"1",selection:{ordinal:1}});expect(files[0]?.url).toBe("https://cdn.example.com/file");expect(rpc.getFileUrl).toHaveBeenCalledWith(source.target,"report-id");expect(rpc.getImage).not.toHaveBeenCalled();
    const images=await lookupHostMedia({database,bridge:rpc,source,messageId:"1",selection:{kind:"image"}});expect(images[0]?.url).toBe("https://cdn.example.com/image");expect(rpc.getMessage).not.toHaveBeenCalled();
    expect(await lookupHostMedia({database,bridge:rpc,source:{scope:"group:200000001",namespace:"group:200000001",target:{kind:"group",groupId:"200000001"}},messageId:"1"})).toEqual([]);expect(rpc.getMessage).not.toHaveBeenCalled();
    await expect(lookupHostMedia({database,bridge:rpc,source:{...source,scope:"private:10000002"},messageId:"1"})).rejects.toThrow("media_scope_denied");
  });
});

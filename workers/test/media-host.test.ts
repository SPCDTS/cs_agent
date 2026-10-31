import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { lookupHostMedia } from "../src/tools/media-host";
import { normalizeMessage } from "../src/policy";
import { action, connect, event } from "./helpers";
import { MediaRepository, type AssetRef } from "../src/media/repository";
const sockets: WebSocket[] = [];
afterEach(async()=>{for (const socket of sockets.splice(0)) socket.close(); await reset();});
const imageRef: AssetRef = { id: "a".repeat(64), scope: "private:10000003", sha256: "b".repeat(64), bytes: 1, mime: "image/png", kind: "image", name: "image" };
function bridge() { return {getMessage:vi.fn(async()=>({})),getFileUrl:vi.fn(async()=>"https://cdn.example.com/file"),getImage:vi.fn(async()=>imageRef),getRecord:vi.fn(async()=>"https://cdn.example.com/audio"),getFile:vi.fn(async()=>"https://cdn.example.com/video")}; }
it("按已核验来源解析fileId与图片引用，选择后才发RPC",async()=>{
  const input=normalizeMessage({...event(1),message:[{type:"file",data:{file_id:"report-id",name:"报告.pdf"}},{type:"image",data:{file:"image-key"}}]});if(!input)throw new Error("fixture");
  const thread=env.THREAD.getByName("private:10000003");await thread.ingest(input);
  await runInDurableObject(thread,async(_instance,state)=>{
    const database=new DurableObjectSqliteDatabase(state.storage),rpc=bridge(),source={scope:"private:10000003",namespace:"private:10000003",target:{kind:"private" as const,userId:"10000003"}};
    const files=await lookupHostMedia({database,bridge:rpc,source,messageId:"1",selection:{ordinal:1}});expect(files[0]?.url).toBe("https://cdn.example.com/file");expect(rpc.getFileUrl).toHaveBeenCalledWith(source.target,"report-id");expect(rpc.getImage).not.toHaveBeenCalled();
    const images=await lookupHostMedia({database,bridge:rpc,source,messageId:"1",selection:{kind:"image"}});expect(images[0]?.assetId).toBe(imageRef.id);expect(rpc.getMessage).not.toHaveBeenCalled();
    expect(await lookupHostMedia({database,bridge:rpc,source:{scope:"group:200000001",namespace:"group:200000001",target:{kind:"group",groupId:"200000001"}},messageId:"1"})).toEqual([]);expect(rpc.getMessage).not.toHaveBeenCalled();
    await expect(lookupHostMedia({database,bridge:rpc,source:{...source,scope:"private:10000002"},messageId:"1"})).rejects.toThrow("media_scope_denied");
  });
});

it("QQ图片从NapCat内容入库，不访问历史URL，私有资产不重复访问QQ", async () => {
  const encoded = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/mQAAAAASUVORK5CYII=";
  const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
  const input = normalizeMessage({ ...event(2), message: [{ type: "image", data: { file: "photo.png", url: "https://multimedia.nt.qq.com.cn/download?rkey=expired" } }] });
  if (!input) throw new Error("fixture");
  const thread = env.THREAD.getByName("private:10000003");
  await thread.ingest(input);
  const { socket, frames } = await connect(sockets);
  const source = { scope: "private:10000003", namespace: "private:10000003", target: { kind: "private" as const, userId: "10000003" } };
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("图片不得由Worker下载"));
  const images = runInDurableObject(thread, async (_instance, state) => lookupHostMedia({
    database: new DurableObjectSqliteDatabase(state.storage), bridge: env.BRIDGE.getByName("napcat"), source, messageId: "2", selection: { kind: "image" },
  }));
  const frame = await action(frames, 0, "get_image");
  expect(frame.params).toMatchObject({ file: "photo.png" });
  socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: frame.echo,
    data: { file: "C:/NapCat/photo.png", url: "https://multimedia.nt.qq.com.cn/download?rkey=expired", base64: encoded, file_name: "photo.png" } }));
  const selected = await images, assetId = selected[0]?.assetId;
  if (!assetId) throw new Error("missing asset");
  const stored = await new MediaRepository({ bucket: env.ASSETS, scope: source.namespace }).get(assetId);
  expect(stored.bytes).toEqual(bytes);
  expect(stored.ref).toMatchObject({ scope: source.namespace, mime: "image/png", kind: "image", bytes: bytes.length });
  await runInDurableObject(thread, async (_instance, state) => {
    const database = new DurableObjectSqliteDatabase(state.storage);
    await database.run("UPDATE message_media SET media_json=? WHERE scope=? AND message_id=?", JSON.stringify(selected), source.scope, "2");
    expect((await lookupHostMedia({ database, bridge: env.BRIDGE.getByName("napcat"), source, messageId: "2" }))[0]?.assetId).toBe(assetId);
  });
  expect(frames).toHaveLength(1);
  expect(network).not.toHaveBeenCalled();
});

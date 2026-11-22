import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { MediaTrace } from "../src/media/diagnostics";
import { lookupHostMedia, readHostMedia } from "../src/tools/media-host";
import { normalizeMessage } from "../src/policy";
import { action, connect, event, input } from "./helpers";
import { scriptedModel } from "./events-helpers";
import { SandboxDO } from "../src/sandbox/do";
import { MediaRepository } from "../src/media/repository";
const sockets: WebSocket[] = [];
afterEach(async()=>{for (const socket of sockets.splice(0)) socket.close(); vi.restoreAllMocks(); await reset();});
const png = new Uint8Array([137,80,78,71,13,10,26,10]);
function bridge() { return {getMessage:vi.fn(async()=>({})),getFileAttachment:vi.fn(async()=>({bytes:png,name:"报告.pdf"})),getImage:vi.fn(async()=>({bytes:png,name:"image"})),getRecord:vi.fn(async()=>"https://cdn.example.com/audio"),getFile:vi.fn(async()=>"https://cdn.example.com/video")}; }
it("按已核验来源解析fileId与图片引用，选择后才发RPC",async()=>{
  const input=normalizeMessage({...event(1),message:[{type:"file",data:{file_id:"report-id",name:"报告.pdf"}},{type:"image",data:{file:"image-key"}}]});if(!input)throw new Error("fixture");
  const thread=env.THREAD.getByName("private:10000003");await thread.ingest(input);
  await runInDurableObject(thread,async(_instance,state)=>{
    const database=new DurableObjectSqliteDatabase(state.storage),rpc=bridge(),source={scope:"private:10000003",namespace:"private:10000003",target:{kind:"private" as const,userId:"10000003"}};
    const repo = new MediaRepository({ bucket: env.ASSETS, scope: source.namespace }), trace = new MediaTrace({}, () => {});
    const files=await lookupHostMedia({database,bridge:rpc,source,messageId:"1",selection:{ordinal:1}});
    expect((await readHostMedia(files[0]!, rpc, repo, trace)).bytes).toEqual(png);
    expect(rpc.getFileAttachment).toHaveBeenCalledWith("report-id");expect(rpc.getImage).not.toHaveBeenCalled();
    const images=await lookupHostMedia({database,bridge:rpc,source,messageId:"1",selection:{kind:"image"}});
    expect((await readHostMedia(images[0]!, rpc, repo, trace)).mime).toBe("image/png");expect(rpc.getMessage).not.toHaveBeenCalled();
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
  const rpc = env.BRIDGE.getByName("napcat"), repo = new MediaRepository({ bucket: env.ASSETS, scope: source.namespace });
  const trace = new MediaTrace({}, () => {});
  const [item] = await runInDurableObject(thread, async (_instance, state) => lookupHostMedia({
    database: new DurableObjectSqliteDatabase(state.storage), bridge: rpc, source, messageId: "2", selection: { kind: "image" },
  }));
  const content = readHostMedia(item!, rpc, repo, trace);
  const frame = await action(frames, 0, "get_image");
  expect(frame.params).toMatchObject({ file: "photo.png" });
  socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: frame.echo,
    data: { file: "C:/NapCat/photo.png", url: "https://multimedia.nt.qq.com.cn/download?rkey=expired", base64: encoded, file_name: "photo.png" } }));
  const remote = await content;
  expect(remote.bytes).toEqual(bytes);
  expect(remote.mime).toBe("image/png");
  const saved = await repo.put({ bytes: remote.bytes, name: remote.name, kind: "image" });
  expect((await readHostMedia({ ...item!, assetId: saved.id }, rpc, repo, trace)).bytes).toEqual(bytes);
  expect(frames).toHaveLength(1);
  expect(network).not.toHaveBeenCalled();
});

it("主人回合通过 qq_attachment 把历史附件交给当前工作区并拿到自选路径", async () => {
  const bytes = new Uint8Array([80, 75, 3, 4, 0, 255]);
  const repo = new MediaRepository({ bucket: env.ASSETS, scope: "owner" });
  const asset = await repo.put({ bytes, name: "pack.zip", kind: "file" });
  const owner = env.THREAD.getByName("owner");
  await owner.ingest({ ...input(59, "包", 10000001), media: [{ kind: "file", ordinal: 1, assetId: asset.id }] });
  const write = vi.spyOn(SandboxDO.prototype, "saveAttachment").mockResolvedValue();
  const model = scriptedModel([{ name: "qq_attachment", args: { message_id: "59", path: "incoming/pack.zip" } }]);
  await owner.submit(input(60, "取回之前发的包", 10000001));
  expect(write).toHaveBeenCalledExactlyOnceWith("/work/incoming/pack.zip", bytes);
  expect(model.outputs.join("\n")).toContain("/work/incoming/pack.zip");
});

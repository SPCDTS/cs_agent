import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import type { Context } from "@earendil-works/chord/context";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { FILE_MAX_BYTES, sha256 } from "../src/media/model";
import { MediaRepository, readMediaToken } from "../src/media/repository";
import { MediaDownloadError, downloadMedia, publicAddress } from "../src/media/download";
import { handleMediaRequest } from "../src/media/routes";
import { MediaTrace, mediaErrorDetail, type MediaDiagnostic } from "../src/media/diagnostics";
import { normalizeMessage, normalizeNotice, type InboundMedia } from "../src/policy";
import { parseFrame } from "../src/onebot";
import { recallMedia, markMessageRecalled, recall } from "../src/context";
import { lookupHostMedia, readHostMedia, type MediaLookupBridge, type VerifiedMediaSource } from "../src/tools/media-host";
import { createMediaExtension, type MediaDeps } from "../src/tools/media";
import { generateImage } from "../src/tools/imagegen";
import { CODEX_BASE_URL } from "../src/models/providers/codex";
import { SandboxDO } from "../src/sandbox/do";
import { SANDBOX_FAILURES } from "../src/sandbox/client";
import { action, connect, event, input } from "./helpers";
import { scriptedModel } from "./events-helpers";

describe("media core and downloads", () => {
  afterEach(async () => { vi.restoreAllMocks(); await reset(); });
  const png = new Uint8Array([137,80,78,71,13,10,26,10,1,2,3]);
  
  describe("私有媒体资产", () => {
    it("二进制按scope隔离且内容校验，票据只授权单个对象并按期失效", async () => {
      const owner = new MediaRepository({ bucket: env.ASSETS, scope: "owner" });
      const asset = await owner.put({ bytes: png, name: "图片.png", kind: "image" });
      expect(asset).toMatchObject({ scope: "owner", mime: "image/png", bytes: png.length, sha256: await sha256(png) });
      expect((await owner.get(asset.id)).bytes).toEqual(png);
      await expect(new MediaRepository({ bucket: env.ASSETS, scope: "group:200000001" }).get(asset.id)).rejects.toThrow("asset_not_found");
      const issued = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(issued);
      const url = await owner.issueUrl(asset.id, "https://agent.example.com", 2);
      expect(url).not.toContain("owner");
      expect(url).not.toContain(asset.id);
      const token = new URL(url).searchParams.get("token") ?? "";
      expect((await readMediaToken(env.ASSETS, token)).bytes).toEqual(png);
      vi.spyOn(Date, "now").mockReturnValue(issued + 2001);
      await expect(readMediaToken(env.ASSETS, token)).rejects.toThrow("media_token_expired");
    });
    it("网页附件上传与下载要求管理员认证，对象票据下载不要求管理员口令", async () => {
      const deps = { bucket: env.ASSETS, authenticateAdmin: (request: Request) => request.headers.get("Authorization") === "Bearer admin-secret" };
      const upload = new Request("https://agent.example.com/media/assets/owner?name=result.bin", { method: "POST", body: png, headers: { Authorization: "Bearer admin-secret" } });
      const response = await handleMediaRequest(upload, deps);
      expect(response?.status).toBe(201);
      const asset = await response!.json<{ id: string }>();
      expect((await handleMediaRequest(new Request(`https://agent.example.com/media/assets/owner/${asset.id}`), deps))?.status).toBe(401);
      const good = await handleMediaRequest(new Request(`https://agent.example.com/media/assets/owner/${asset.id}`, { headers: { Authorization: "Bearer admin-secret" } }), deps);
      expect(new Uint8Array(await good!.arrayBuffer())).toEqual(png);
      const repo = new MediaRepository({ bucket: env.ASSETS, scope: "owner" });
      const publicResponse = await handleMediaRequest(new Request(await repo.issueUrl(asset.id, "https://agent.example.com")), deps);
      expect(publicResponse?.status).toBe(200);
      expect(publicResponse?.headers.get("Content-Disposition")).toContain("attachment;");
      expect(new Uint8Array(await publicResponse!.arrayBuffer())).toEqual(png);
    });
    it("拒绝超限与伪装成图片的文件", async () => {
      const repo = new MediaRepository({ bucket: env.ASSETS, scope: "owner" });
      await expect(repo.put({ bytes: new Uint8Array(FILE_MAX_BYTES + 1), name: "big" })).rejects.toThrow("too_large");
      await expect(repo.put({ bytes: new Uint8Array([1,2,3]), name: "fake.png", mime: "image/png", kind: "image" })).rejects.toThrow("unsupported_image");
    });
  });
  describe("有界公网下载", () => {
    it.each([200, 302])("默认DNS下载路径在Workers中支持图片入库，并拒绝DNS重定向（%s）", async status => {
      const image = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/mQAAAAASUVORK5CYII="), char => char.charCodeAt(0));
      const requests: string[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        // 保留 Workers 原生 Request 校验，只替换外网响应，避免注入 resolve 绕过 DNS 路径。
        const request = new Request(input, init), url = new URL(request.url);
        requests.push(url.hostname);
        if (url.hostname === "cloudflare-dns.com") {
          if (status === 302) return new Response(null, { status, headers: { Location: "https://other.example.com/dns-query" } });
          return Response.json({ Answer: url.searchParams.get("type") === "A" ? [{ type: 1, data: "1.1.1.1" }] : [] });
        }
        if (url.href === "https://multimedia.nt.qq.com.cn/image.png") return new Response(image, { headers: { "Content-Type": "image/png" } });
        throw new Error("unexpected_media_request");
      });
      const repo = new MediaRepository({ bucket: env.ASSETS, scope: "owner" });
      const imported = repo.importRemote({ url: "https://multimedia.nt.qq.com.cn/image.png", kind: "image" });
      if (status === 302) {
        await expect(imported).rejects.toThrow("media_dns_failed");
        expect(requests).toEqual(["cloudflare-dns.com", "cloudflare-dns.com"]);
      } else {
        const asset = await imported;
        expect(asset).toMatchObject({ kind: "image", mime: "image/png", bytes: image.length });
        expect((await repo.get(asset.id)).bytes).toEqual(image);
        expect(requests).toEqual(["cloudflare-dns.com", "cloudflare-dns.com", "multimedia.nt.qq.com.cn"]);
      }
    });
  
    it("拒绝内网、混合DNS、保留地址和重定向到内网", async () => {
      for (const address of ["127.0.0.1", "10.0.0.1", "192.168.0.2", "169.254.169.254", "100.64.0.1", "::1", "::ffff:127.0.0.1", "fd00::1", "2001:db8::1"]) expect(publicAddress(address), address).toBe(false);
      expect(publicAddress("1.1.1.1")).toBe(true);
      expect(publicAddress("2606:4700:4700::1111")).toBe(true);
      const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/secret" } }));
      await expect(downloadMedia("https://cdn.example.com/a", { fetch: request, resolve: async () => ["1.1.1.1"] })).rejects.toThrow("media_url_denied");
      expect(request).toHaveBeenCalledTimes(1);
      await expect(downloadMedia("https://cdn.example.com/a", { fetch: request, resolve: async () => ["1.1.1.1", "10.0.0.1"] })).rejects.toThrow("media_url_denied");
      expect(request).toHaveBeenCalledTimes(1);
    });
    it("取消的下载不发请求", async () => {
      const request = vi.fn<typeof fetch>();
      await expect(downloadMedia("https://cdn.example.com/a", { fetch: request, signal: AbortSignal.abort() })).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
    });
    it("流式拒绝没有Content-Length的超限响应", async () => {
      const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(FILE_MAX_BYTES + 1)));
      await expect(downloadMedia("https://cdn.example.com/a", { fetch: request, resolve: async () => ["1.1.1.1"] })).rejects.toThrow("too_large");
    });
  });
});

describe("media context", () => {
  afterEach(async () => { await reset(); });
  describe("QQ媒体上下文", () => {
    it("保留各类媒体引用", () => {
      const input = normalizeMessage({ ...event(1), message: [
        { type: "image", data: { url: "https://cdn.example.com/a", file: "a.image", file_id: "i" } },
        { type: "file", data: { file_id: "f", name: "报告.pdf", file_size: 24 } },
        { type: "record", data: { url: "https://cdn.example.com/b" } },
        { type: "video", data: { file: "https://cdn.example.com/c" } },
      ] });
      expect(input?.media).toEqual([
        { kind: "image", ordinal: 1, url: "https://cdn.example.com/a", file: "a.image", fileId: "i" },
        { kind: "file", ordinal: 2, fileId: "f", name: "报告.pdf", size: 24 },
        { kind: "audio", ordinal: 3, url: "https://cdn.example.com/b" },
        { kind: "video", ordinal: 4, file: "https://cdn.example.com/c" },
      ]);
    });
    it("上传与撤回notice独立归一化", () => {
      const base = { post_type: "notice", self_id: 10000000, user_id: 10000003, group_id: 200000001, time: 5 };
      const upload = normalizeNotice({ ...base, notice_type: "group_upload", file: { id: "file-1", name: "报告.pdf", size: 12 } });
      expect(upload).toMatchObject({ kind: "upload", input: { routeText: "", media: [{ kind: "file", fileId: "file-1", name: "报告.pdf" }] } });
      expect(parseFrame(JSON.stringify({ ...base, notice_type: "group_recall", message_id: 8 }))).toEqual({ kind: "notice", notice: {
        kind: "recall", messageId: "8", selfId: "10000000", userId: "10000003", time: 5, target: { kind: "group", groupId: "200000001" },
      } });
    });
    it("历史引用按scope召回，撤回后停止召回并保留标注", async () => {
      const input = normalizeMessage({ ...event(1), message: [{ type: "image", data: { url: "https://cdn.example.com/a" } }] });
      if (!input) throw new Error("fixture");
      const thread = env.THREAD.getByName("private:10000003");
      await thread.ingest(input);
      const result = await runInDurableObject(thread, async (_instance, state) => {
        const database = new DurableObjectSqliteDatabase(state.storage);
        const own = await recallMedia(database, "private:10000003", "1"), other = await recallMedia(database, "group:200000001", "1");
        const before = await recall(database, "private:10000003", {});
        await markMessageRecalled(database, "private:10000003", "1");
        let denied = false;
        try { await recallMedia(database, "private:10000003", "1"); } catch { denied = true; }
        return { own, other, before, denied, after: await recall(database, "private:10000003", {}) };
      });
      expect(result.own).toHaveLength(1); expect(result.other).toEqual([]);
      expect(result.before).toContain("message_id:1"); expect(result.denied).toBe(true); expect(result.after).toContain("已撤回");
    });
  });
});

describe("media host lookup and attachments", () => {
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
    const write = vi.spyOn(SandboxDO.prototype, "writeFile").mockResolvedValue({ bytes: bytes.length });
    const model = scriptedModel([{ name: "qq_attachment", args: { message_id: "59", path: "incoming/pack.zip" } }]);
    await owner.submit(input(60, "取回之前发的包", 10000001));
    expect(write).toHaveBeenCalledExactlyOnceWith("/work/incoming/pack.zip", bytes, undefined, true);
    expect(model.outputs.join("\n")).toContain("/work/incoming/pack.zip");
  });
});

describe("media observability and diagnostics", () => {
  const sockets: WebSocket[] = [];
  afterEach(async () => { for (const socket of sockets.splice(0)) socket.close(); vi.restoreAllMocks(); await reset(); });
  const secret = "synthetic_private_cookie_and_token";
  const url = "https://1.1.1.1/private?token=" + secret;
  const privateSource = { scope: "private:10000003", namespace: "private:10000003", target: { kind: "private" as const, userId: "10000003" } };
  function fixture(source: VerifiedMediaSource = privateSource, bridge?: MediaLookupBridge) {
    const logs: MediaDiagnostic[] = [];
    const repo = new MediaRepository({ bucket: env.ASSETS, scope: source.namespace });
    let items: InboundMedia[] = [{ kind: "file", ordinal: 1, fileId: "private-file-reference", name: "private-name.txt" }];
    const database = { get: vi.fn(async (sql: string) => sql.includes("message_media")
      ? (items.length ? { media_json: JSON.stringify(items), recalled: 0 } : undefined) : { message_id: "1" }) } as unknown as Parameters<typeof lookupHostMedia>[0]["database"];
    const rpc = {
      getMessage: vi.fn(async () => ({ message_id: "1", user_id: "10000003", message_type: "private", message: [{ type: "file", data: { url } }] })),
      getFileAttachment: vi.fn<MediaLookupBridge["getFileAttachment"]>(async () => url), getFile: vi.fn(async () => url), getRecord: vi.fn(async () => url),
      getImage: vi.fn<MediaLookupBridge["getImage"]>(),
    };
    const record = vi.fn(async (_kind: string, _detail: object) => {});
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new Uint8Array([1, 2, 3])));
    const deps: MediaDeps = {
      bridge: bridge ?? rpc, canWriteWorkspace: async () => false, storeFile: async () => { throw new Error("unexpected_write"); },
      allowed: async () => true, scope: async () => source.scope, repository: async () => repo,
      lookup: (messageId, _api, _context, selection, trace) => lookupHostMedia({ database, bridge: bridge ?? rpc, source, messageId, selection, trace }),
      sandbox: async () => { throw new Error("unused"); }, deliver: async () => {}, record, log: event => logs.push(event),
    };
    const run = async (args: { message_id: string; ordinal?: number; path?: string } = { message_id: "1", ordinal: 1 }) => {
      const tool: ToolRegistration = createMediaExtension(deps).tools!.find(tool => tool.name === "qq_attachment")!;
      return tool.execute(args, {} as ToolExecutionApi, {} as Context);
    };
    return { logs, repo, rpc, database, record, fetcher, deps, run, setItems: (next: InboundMedia[]) => { items = next; } };
  }
  
  describe("附件阶段诊断", () => {
    it("同一trace贯穿解析下载存储审计，成功资产不因审计失败而丢失", async () => {
      const f = fixture(), put = vi.spyOn(f.repo, "put");
      f.record.mockRejectedValue(new Error("audit " + secret));
      const result = await f.run();
      expect(result.isError).not.toBe(true);
      expect(put).toHaveBeenCalledTimes(1);
      expect(f.record).toHaveBeenCalledTimes(1);
      const identity = f.logs.find(row => row.stage === "store")!;
      expect(identity).toMatchObject({ message_id: "1", ordinal: 1, scope: privateSource.scope });
      expect(identity.traceId).toMatch(/^[a-f0-9-]{36}$/);
      expect(new Set(f.logs.map(row => row.traceId)).size).toBe(1);
      for (const stage of ["lookup", "metadata", "resolve_url", "get_file", "download", "store"]) {
        expect(f.logs.filter(row => row.stage === stage).map(row => row.state)).toEqual(["start", "success"]);
      }
      expect(f.logs.filter(row => row.stage === "audit").map(row => row.state)).toEqual(["start", "failure"]);
      expect(f.record.mock.calls[0]?.[1]).toMatchObject({ traceId: identity.traceId, message_id: "1", scope: privateSource.scope, result: "ok" });
      const serialized = JSON.stringify(f.logs);
      for (const value of [secret, url, "private-file-reference", "private-name.txt"]) expect(serialized).not.toContain(value);
      expect(f.logs.every(row => Number.isInteger(row.ms) && row.ms >= 0 && row.ms <= 86_400_000)).toBe(true);
      const payload = result.output?.find(part => part.type === "text");
      if (payload?.type !== "text") throw new Error("missing_ref");
      const ref = JSON.parse(payload.text) as { id: string };
      expect((await f.repo.get(ref.id)).bytes).toEqual(new Uint8Array([1, 2, 3]));
    });
  
    it.each([
      ["lookup", "media_unexpected_error"], ["metadata", "media_unexpected_error"], ["get_msg", "onebot_failed"],
      ["resolve_url", "media_reference_missing"],
      ["get_file", "onebot_timeout"], ["download", "media_type_error"], ["store", "media_unexpected_error"],
    ])("故障注入定位%s，保留错误码且审计失败不覆盖业务失败", async (stage, code) => {
      const f = fixture();
      const native = new Error("sensitive " + url + " cookie=" + secret);
      if (stage === "lookup") f.deps.lookup = async () => { throw native; };
      if (stage === "metadata") vi.spyOn(f.database, "get").mockRejectedValue(native);
      if (stage === "get_msg") { f.setItems([]); f.rpc.getMessage.mockRejectedValue(new Error("onebot_failed: " + secret)); }
      if (stage === "resolve_url") f.setItems([{ kind: "file", ordinal: 1 }]);
      if (stage === "get_file") f.rpc.getFileAttachment.mockRejectedValue(new Error("onebot_timeout: " + secret));
      if (stage === "download") f.fetcher.mockRejectedValue(new TypeError(url));
      if (stage === "store") vi.spyOn(f.repo, "put").mockRejectedValue(native);
      f.record.mockRejectedValue(new Error("secondary " + secret));
      const result = await f.run();
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.output)).toContain(code + "：");
      expect(f.logs.find(row => row.stage === stage && row.state === "failure")).toMatchObject({ code });
      expect(f.record.mock.calls[0]?.[1]).toMatchObject({ result: code, failedStage: stage });
      expect(f.record).toHaveBeenCalledTimes(1);
      const traceId = f.logs[0]!.traceId;
      expect(JSON.stringify(result.output)).toContain(traceId);
      expect(f.logs.every(row => row.traceId === traceId)).toBe(true);
      expect(JSON.stringify([f.logs, f.record.mock.calls, result.output])).not.toContain(secret);
      expect(JSON.stringify(f.logs)).not.toContain("https://");
    });
  
    it("get_msg回退与按ordinal选择均可追踪，另一回合不会复用trace", async () => {
      const f = fixture();
      f.setItems([]);
      await f.run();
      expect(f.logs.some(row => row.stage === "get_msg" && row.state === "success")).toBe(true);
      const first = f.logs[0]!.traceId;
      f.logs.length = 0;
      f.setItems([{ kind: "file", ordinal: 1, fileId: "do-not-read" }, { kind: "file", ordinal: 2, file: "second" }]);
      f.rpc.getFileAttachment.mockRejectedValue(new Error("onebot_disconnected"));
      await f.run({ message_id: "1", ordinal: 2 });
      expect(f.logs[0]!.traceId).not.toBe(first);
      expect(f.rpc.getFileAttachment.mock.calls.map(([file]) => file)).toEqual(["second"]);
      expect(f.logs.find(row => row.stage === "get_file" && row.state === "failure")).toMatchObject({ ordinal: 2, code: "onebot_disconnected" });
    });
  
    it("无附件与权限拒绝不是成功审计，拒绝时不访问附件", async () => {
      const f = fixture();
      f.deps.lookup = vi.fn(async () => []);
      expect((await f.run()).isError).toBe(true);
      expect(f.record.mock.calls[0]?.[1]).toMatchObject({ result: "media_not_found" });
      f.deps.allowed = async () => false;
      expect((await f.run()).isError).toBe(true);
      expect(f.deps.lookup).toHaveBeenCalledTimes(1);
      expect(f.fetcher).not.toHaveBeenCalled();
    });
  });
  
  describe("错误结构与原始异常", () => {
    it("仅允许稳定错误码和有界数值，原始异常与日志sink失败互不污染", async () => {
      const error = new TypeError(url), logs: MediaDiagnostic[] = [], trace = new MediaTrace({ messageId: "upload:" + url, ordinal: 999 }, row => logs.push(row));
      trace.setScope("owner?" + secret);
      await expect(trace.run("lookup", () => trace.run("get_msg", async () => { throw error; }))).rejects.toBe(error);
      expect(trace.summary()).toMatchObject({ failedStage: "get_msg", message_id: "redacted", scope: "redacted" });
      expect(JSON.stringify(logs)).not.toContain(secret);
      expect(logs.every(row => row.ordinal === undefined)).toBe(true);
      const brokenSink = new MediaTrace({}, () => { throw new Error(secret); });
      expect(await brokenSink.run("store", async () => 42)).toBe(42);
      await expect(brokenSink.run("store", async () => { throw error; })).rejects.toBe(error);
      for (const code of SANDBOX_FAILURES) expect(mediaErrorDetail(new Error(code)).code).toBe(code);
      expect(mediaErrorDetail(new Error(secret))).toMatchObject({ code: "media_unexpected_error" });
      expect(mediaErrorDetail(new SyntaxError(secret)).code).toBe("media_invalid_json");
      expect(mediaErrorDetail(new DOMException(secret, "AbortError")).code).toBe("media_aborted");
      expect(mediaErrorDetail(new DOMException(secret, "TimeoutError")).code).toBe("media_timeout");
      expect(mediaErrorDetail({ token: secret }).code).toBe("media_unknown_error");
      expect(mediaErrorDetail(new MediaDownloadError(403, secret))).toEqual({ code: "media_download_failed", errorType: "MediaDownloadError", status: 403 });
      expect(mediaErrorDetail(new Error("onebot_failed:retcode=-1")).retcode).toBe(-1);
      expect(mediaErrorDetail(new Error("onebot_failed:retcode=99999999999")).retcode).toBeUndefined();
    });
  
    it("下载阶段保留HTTP状态、超时和原始读取流异常，不泄露URL", async () => {
      const logs: MediaDiagnostic[] = [], trace = new MediaTrace({ messageId: "1" }, row => logs.push(row));
      await expect(downloadMedia(url, { trace, fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 })) })).rejects.toBeInstanceOf(MediaDownloadError);
      expect(logs.at(-1)).toMatchObject({ stage: "download", state: "failure", code: "media_download_failed", status: 403 });
      const timeout = new DOMException(secret, "TimeoutError");
      await expect(downloadMedia(url, { trace, signal: AbortSignal.abort(timeout) })).rejects.toBe(timeout);
      expect(logs.at(-1)).toMatchObject({ code: "media_timeout" });
      const original = new Error(url);
      const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(original); } });
      await expect(downloadMedia(url, { trace, fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(body)) })).rejects.toBe(original);
      expect(JSON.stringify(logs)).not.toContain(secret);
    });
  });
  
  it.each<VerifiedMediaSource>([
    { ...privateSource, namespace: "owner" },
    { scope: "group:200000001", namespace: "group:200000001", target: { kind: "group", groupId: "200000001" } },
  ])("qq_attachment 在 $scope 按 file_id 取回原始字节并直接交给工作区", async source => {
    const f = fixture(source, env.BRIDGE.getByName("napcat")), { socket, frames } = await connect(sockets);
    f.setItems([{ kind: "file", ordinal: 1, fileId: "platform-id", file: "报告.bin", url, name: "报告.bin" }]);
    f.deps.canWriteWorkspace = async () => true;
    const write = vi.fn<MediaDeps["storeFile"]>(async () => {});
    f.deps.storeFile = write;
    const custom = source.namespace === "owner";
    const pending = f.run({ message_id: "1", ordinal: 1, ...(custom ? { path: "inbox/报告.bin" } : {}) });
    const frame = await action(frames, 0, "get_file");
    expect(frame.params).toEqual({ file: "platform-id" });
    const data = { file: "/qq/cache/blob", url: "/qq/cache/blob", base64: "AP+A", file_size: "3", file_name: "blob" };
    socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: frame.echo, data }));
    const result = await pending, output = result.output?.[0];
    expect(result.isError).not.toBe(true);
    if (output?.type !== "text") throw new Error("missing_ref");
    const saved = JSON.parse(output.text);
    expect(saved).toMatchObject({ name: "报告.bin", kind: "file", bytes: 3 });
    expect(saved.path).toMatch(custom ? /^\/work\/inbox\/报告\.bin$/ : /^r2:\/\/attachments\/[a-f0-9]{64}\/报告\.bin$/);
    expect(write.mock.calls[0]?.slice(0, 2)).toEqual([saved.path, new Uint8Array([0, 255, 128])]);
    expect((await env.ASSETS.list()).objects).toHaveLength(0);
    expect(frames).toHaveLength(1);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify([f.logs, f.record.mock.calls, result.output])).not.toContain(data.base64);
  });
  
  it.each([
    [{ file: "/qq/cache/blob", url: "/qq/cache/blob" }, "napcat_file_content_missing"],
    [{ base64: "%%%invalid%%%", url }, "invalid_file_content"],
    [{ base64: "AA==", file_size: "2" }, "invalid_file_content"],
  ])("get_file 拒绝无法读取或不完整的内容（%j → %s）", async (data, code) => {
    const f = fixture(privateSource, env.BRIDGE.getByName("napcat")), { socket, frames } = await connect(sockets);
    const pending = f.run(), frame = await action(frames, 0, "get_file");
    socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: frame.echo, data }));
    expect((await pending).isError).toBe(true);
    expect(f.logs.find(row => row.stage === "get_file" && row.state === "failure")).toMatchObject({ code });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  
  it("指定路径要求写权限、仅选一个附件且位于工作区内", async () => {
    const f = fixture();
    expect(JSON.stringify((await f.run({ message_id: "1", path: "package.zip" })).output)).toContain("permission_denied");
    f.deps.canWriteWorkspace = async () => true;
    expect(JSON.stringify((await f.run({ message_id: "1", path: "../escape.zip" })).output)).toContain("path_denied");
    f.setItems([{ kind: "file", ordinal: 1, fileId: "one" }, { kind: "file", ordinal: 2, fileId: "two" }]);
    expect(JSON.stringify((await f.run({ message_id: "1", path: "package.zip" })).output)).toContain("attachment_path_ambiguous");
    expect(f.rpc.getFileAttachment).not.toHaveBeenCalled();
  });
  
  it("工作区写失败保留原错误，不写私有资产或返回成功路径", async () => {
    const f = fixture(), put = vi.spyOn(f.repo, "put");
    f.deps.canWriteWorkspace = async () => true;
    f.deps.storeFile = async () => { throw new Error("workspace_quota"); };
    const result = await f.run({ message_id: "1", ordinal: 1, path: "inbox/sensitive.zip" });
    expect(result.isError).toBe(true);
    expect(f.record.mock.calls[0]?.[1]).toMatchObject({ result: "workspace_quota", failedStage: "workspace_write" });
    expect(JSON.stringify([result.output, f.logs, f.record.mock.calls])).not.toContain("sensitive.zip");
    expect(put).not.toHaveBeenCalled();
  });
  
  it("真实OneBot拒绝仅传递有界retcode，宿主trace不依赖RPC自定义异常字段", async () => {
    const f = fixture(privateSource, env.BRIDGE.getByName("napcat")), { socket, frames } = await connect(sockets);
    const pending = f.run();
    const request = await action(frames, 0, "get_file");
    socket.send(JSON.stringify({ status: "failed", retcode: 1200, echo: request.echo, wording: secret, data: { url } }));
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(f.logs.find(row => row.stage === "get_file" && row.state === "failure")).toMatchObject({ code: "onebot_failed", retcode: 1200 });
    expect(JSON.stringify([f.logs, result.output])).not.toContain(secret);
    expect(parseFrame(JSON.stringify({ echo: "x", status: "failed", retcode: secret }))).not.toHaveProperty("retcode");
  });
  
  it("已有资产读取可追踪且不重新下载，损坏资产保留稳定错误码", async () => {
    const f = fixture(), asset = await f.repo.put({ bytes: new Uint8Array([1]), name: "cached", kind: "file" });
    f.setItems([{ kind: "file", ordinal: 1, assetId: asset.id }]);
    expect((await f.run()).isError).not.toBe(true);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.logs.some(row => row.stage === "asset_get" && row.state === "success")).toBe(true);
    expect(f.logs.some(row => row.stage === "download" || row.stage === "store")).toBe(false);
    vi.spyOn(f.repo, "get").mockRejectedValue(new Error("asset_corrupt"));
    expect((await f.run()).isError).toBe(true);
    expect(f.record.mock.calls.at(-1)?.[1]).toMatchObject({ result: "asset_corrupt", failedStage: "asset_get" });
  });
  
  it("未指定ordinal时逐件读取的失败仍关联正确附件", async () => {
    const f = fixture();
    f.setItems([{ kind: "file", ordinal: 1, fileId: "first" }, { kind: "file", ordinal: 2, fileId: "second" }]);
    f.rpc.getFileAttachment.mockImplementation(async file => { if (file === "second") throw new Error("onebot_failed"); return url; });
    const result = await f.run({ message_id: "1" });
    expect(result.isError).toBe(true);
    expect(f.record.mock.calls[0]?.[1]).toMatchObject({ ordinal: 2, failedStage: "get_file" });
    expect(f.logs.filter(row => row.stage === "get_file" && row.state === "start").map(row => row.ordinal)).toEqual([1, 2]);
  });
  
  it("明确大小限制错误不被通用提示反向否认", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValue(new Response(new Uint8Array([1]), { headers: { "content-length": "11000000" } }));
    const result = await f.run();
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.output)).toContain("too_large");
    expect(JSON.stringify(result.output)).not.toContain("不能据此认定");
    f.setItems([{ kind: "file", ordinal: 1, fileId: "too-large", size: 11_000_000 }]);
    f.rpc.getFileAttachment.mockClear();
    expect((await f.run()).isError).toBe(true);
    expect(f.rpc.getFileAttachment).not.toHaveBeenCalled();
    expect(f.record.mock.calls.at(-1)?.[1]).toMatchObject({ result: "too_large", failedStage: "resolve_url" });
  });
});

describe("imagegen", () => {
  afterEach(async () => { vi.restoreAllMocks(); await reset(); });
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/mQAAAAASUVORK5CYII=";
  const models = { getAuth: async () => ({ auth: { apiKey: "synthetic-codex", baseUrl: CODEX_BASE_URL, headers: { "chatgpt-account-id": "synthetic-account" } } }) };
  it("编辑读取会话图片后直传 Codex，结果入库；跨会话引用在发请求前被拒绝", async () => {
    const repository = new MediaRepository({ bucket: env.ASSETS, scope: "owner" });
    const original = await repository.put({ bytes: Buffer.from(png, "base64"), name: "原图.png" });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe(CODEX_BASE_URL + "/images/edits");
      expect(request.redirect).toBe("manual");
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-codex");
      expect(await request.json()).toMatchObject({ images: [{ image_url: "data:image/png;base64," + png }], background: "transparent" });
      return Response.json({ data: [{ b64_json: png }] });
    });
    const result = await generateImage({ prompt: "去掉背景", images: [original.id], background: "transparent" }, { models, repository, operationId: "edit-test" });
    expect((await repository.get(result.ref.id)).ref).toMatchObject({ mime: "image/png", scope: "owner" });
    await expect(generateImage({ prompt: "改图", images: [original.id] }, { models,
      repository: new MediaRepository({ bucket: env.ASSETS, scope: "group:200000001" }), operationId: "denied" })).rejects.toMatchObject({ code: "asset" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("额度错误不重试，不泄漏上游正文，并保留脱敏请求标识", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("private-upstream-detail", { status: 429, headers: { "x-request-id": "req-image-test" } }));
    await expect(generateImage({ prompt: "画猫" }, { models, repository: new MediaRepository({ bucket: env.ASSETS, scope: "owner" }), operationId: "limited" }))
      .rejects.toMatchObject({ code: "rate_limit", diagnostic: { status: 429, requestId: "req-image-test" } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

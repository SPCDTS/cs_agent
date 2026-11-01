import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import * as models from "../src/models";
import { MediaRepository, readMediaToken } from "../src/media/repository";
import { downloadMedia } from "../src/media/download";
import { WEB_FETCH_MAX_BYTES } from "../src/tools/web-media";
import { scriptedModel } from "./events-helpers";
import { action, connect, input, reply } from "./helpers";

const sockets: WebSocket[] = [];
afterEach(async () => { for (const socket of sockets.splice(0)) socket.close(); vi.restoreAllMocks(); await reset(); });
const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1sAAAAASUVORK5CYII=";
const png = Uint8Array.from(atob(data), c => c.charCodeAt(0));
const group = "group:200000001";
const script = `const page = await tools.web_fetch({url:"https://shop.example.com/jersey"});
const relative = /<img src="([^"]+)"/.exec(page.body)[1];
const result = await tools.web_import_image({url:relative,baseUrl:page.url,name:"队服.png"});
text(result.asset); image(result.image);`;

function publicWeb(route: (url: URL) => Response | Promise<Response> = url => url.pathname === "/jersey"
  ? new Response('<html><!--' + "x".repeat(100_000) + '--><img src="/jersey.png"></html>', { headers: { "Content-Type": "text/html; charset=utf-8" } })
  : new Response(png, { headers: { "Content-Type": "image/png" } })) {
  const requests: Request[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (resource, init) => {
    const request = new Request(resource, init), url = new URL(request.url);
    requests.push(request);
    if (url.hostname === "cloudflare-dns.com") return Response.json({ Answer: url.searchParams.get("type") === "A" ? [{ type: 1, data: "1.1.1.1" }] : [] });
    if (url.hostname !== "shop.example.com") throw new Error("unexpected_test_destination");
    return route(url);
  });
  return requests;
}

function inspectThenSend() {
  const faux = fauxProvider({ models: [{ id: "test", input: ["text", "image"] }], tokensPerSecond: Infinity });
  const images: string[] = [];
  let step = 0, assetId = "";
  const respond: FauxResponseFactory = transcript => {
    faux.setResponses([respond]);
    for (const message of transcript.messages) if (message.role === "toolResult") for (const block of message.content) {
      if (block.type === "image") images.push(block.data);
      if (block.type === "text") assetId ||= /"id":"([a-f0-9]{64})"/.exec(block.text)?.[1] ?? "";
    }
    if (step++ === 0) return fauxAssistantMessage(fauxToolCall("codemode", { code: script }), { stopReason: "toolUse" });
    if (step === 2) return fauxAssistantMessage(fauxToolCall("send_message", { text: "队服照片", images: [assetId] }), { stopReason: "toolUse" });
    return fauxAssistantMessage("done");
  };
  faux.setResponses([respond]);
  vi.spyOn(models, "openModels").mockImplementation(() => { const registry = createModels(); registry.setProvider(faux.provider); return registry; });
  return { images, assetId: () => assetId };
}

describe("Code Mode 公网取图", () => {
  it("未授权MCP的群成员可解析网页、查看图片并通过原群发送真实图片段", async () => {
    const requests = publicWeb(), seen = inspectThenSend();
    const { socket, frames } = await connect(sockets);
    const run = env.THREAD.getByName(group).submit(input(1, "找队服照片发一下", 10000004, 200000001, true));
    const sent = await action(frames);
    expect(sent.params).toMatchObject({ group_id: "200000001", message: [
      { type: "at", data: { qq: "10000004" } }, { type: "text", data: { text: "队服照片" } },
      { type: "image", data: { file: expect.stringContaining("/media/object?token=") } },
    ] });
    const image = sent.params.message?.find(segment => segment.type === "image");
    if (!Check(Type.Object({ data: Type.Object({ file: Type.String() }) }), image)) throw new Error("missing_image");
    const token = new URL(image.data.file).searchParams.get("token");
    if (!token) throw new Error("missing_token");
    expect((await readMediaToken(env.ASSETS, token)).bytes).toEqual(png);
    reply(socket, sent.echo);
    expect(await run).toEqual({ status: "done" });
    expect(seen.images).toContain(data);
    const repository = new MediaRepository({ bucket: env.ASSETS, scope: group });
    expect((await repository.get(seen.assetId())).ref).toMatchObject({ name: "队服.png", kind: "image", scope: group });
    await expect(new MediaRepository({ bucket: env.ASSETS, scope: "owner" }).get(seen.assetId())).rejects.toThrow("asset_not_found");
    expect(requests.every(r => r.method === "GET" && !r.headers.has("Authorization") && !r.headers.has("Cookie"))).toBe(true);
    expect(requests.some(r => r.url === "https://shop.example.com/jersey.png")).toBe(true);
    await expect.poll(async () => (await env.BRIDGE.getByName("napcat").deliveryList()).some(d => d.state === "sent")).toBe(true);
  });

  it("owner与群网页回合均可取图，网页只保存网页输出", async () => {
    publicWeb();
    const owner = scriptedModel([{ name: "codemode", args: { code: script } }]);
    await env.THREAD.getByName("owner").submit(input(1, "取图", 10000001));
    expect(owner.outputs.join("\n")).toContain('"scope":"owner"');
    vi.restoreAllMocks();
    publicWeb();
    const seen = inspectThenSend(), thread = env.THREAD.getByName(group);
    await thread.submitWeb(group, crypto.randomUUID(), "找队服图片");
    await expect.poll(async () => (await thread.chatView(group)).messages.some(m => m.role === "assistant")).toBe(true);
    await expect.poll(async () => (await thread.chatView(group)).active).toBe(0);
    const view = await thread.chatView(group);
    expect(view.messages.find(m => m.role === "assistant")).toMatchObject({ source: "web", text: "队服照片", assets: [{ id: seen.assetId(), scope: group }] });
    expect(await env.BRIDGE.getByName("napcat").deliveryList()).toHaveLength(0);
  });

  it.each([
    { name: "网页超限", code: 'text(await tools.web_fetch({url:"https://shop.example.com/large"}));', result: "too_large", response: () => new Response("x".repeat(WEB_FETCH_MAX_BYTES + 1), { headers: { "Content-Type": "text/html" } }) },
    { name: "网页读取拒绝二进制", code: 'text(await tools.web_fetch({url:"https://shop.example.com/image"}));', result: "unsupported_type", response: () => new Response(png, { headers: { "Content-Type": "image/png" } }) },
    { name: "伪图片", code: 'text(await tools.web_import_image({url:"https://shop.example.com/fake.png"}));', result: "unsupported_image", response: () => new Response("<html>not an image</html>", { headers: { "Content-Type": "image/png" } }) },
    { name: "跳转内网", code: 'text(await tools.web_fetch({url:"https://shop.example.com/redirect"}));', result: "media_url_denied", response: () => new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/secret" } }) },
    { name: "HTTP失败", code: 'text(await tools.web_import_image({url:"https://shop.example.com/denied?secret=private"}));', result: "media_download_failed", response: () => new Response("private-error", { status: 403 }) },
  ])("$name返回可诊断错误且不产生资产", async ({ code, result, response }) => {
    const requests = publicWeb(response), seen = scriptedModel([{ name: "codemode", args: { code } }]);
    await env.THREAD.getByName(group).submit(input(1, "取图", 10000004, 200000001, true));
    expect(seen.outputs.join("\n")).toContain(result);
    expect(requests.filter(r => r.url.startsWith("http://127."))).toHaveLength(0);
    expect((await env.ASSETS.list()).objects).toHaveLength(0);
    const audit = await runInDurableObject(env.THREAD.getByName(group), (_instance, state) =>
      state.storage.sql.exec<{ detail: string }>("SELECT detail FROM events WHERE kind IN ('web_fetch','web_import_image')").toArray());
    expect(audit.map(r => JSON.parse(r.detail))).toContainEqual(expect.objectContaining({ result }));
    expect(JSON.stringify(audit)).not.toMatch(/secret|private-error|fake.png/);
    if (result === "media_download_failed") expect(audit.map(r => JSON.parse(r.detail))).toContainEqual(expect.objectContaining({ status: 403, hostname: "shop.example.com" }));
  });

  it("导入期间会话代次变化后拒绝写入资产", async () => {
    publicWeb(async () => {
      await runInDurableObject(env.THREAD.getByName(group), (_instance, state) => { state.storage.sql.exec("UPDATE session_state SET generation=generation+1 WHERE id=1"); });
      return new Response(png, { headers: { "Content-Type": "image/png" } });
    });
    const seen = scriptedModel([{ name: "codemode", args: { code: 'text(await tools.web_import_image({url:"https://shop.example.com/image"}));' } }]);
    await env.THREAD.getByName(group).submit(input(1, "取图", 10000004, 200000001, true));
    expect(seen.outputs.join("\n")).toContain("web_media_denied");
    expect((await env.ASSETS.list()).objects).toHaveLength(0);
  });

  it("取消的下载不发请求", async () => {
    const requests = publicWeb();
    await expect(downloadMedia("https://shop.example.com/image", { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
});

import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { openModels } from "../src/models";
import { codexSearch } from "../src/search";
import type { ModelView } from "../src/registry";
import { codexLogin, codexStore, completed, fakeCodex, hostedItem, messageItem, sse } from "./codex-helpers";
import { scriptedModel } from "./events-helpers";
import { action, connect, input, reply } from "./helpers";

const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  vi.restoreAllMocks();
  await reset();
});

const SEARCH_TEXT = [
  "1. Durable Objects | https://developers.cloudflare.com/durable-objects/?utm_source=openai | 有状态的 Workers",
  "- [Pricing](https://developers.cloudflare.com/workers/platform/pricing/?ref=docs&utm_source=openai) | 计费说明",
].join("\n");
const SEARCHED = [{ title: "Durable Objects", url: "https://developers.cloudflare.com/durable-objects/", snippet: "有状态的 Workers" },
  { title: "Pricing", url: "https://developers.cloudflare.com/workers/platform/pricing/?ref=docs", snippet: "计费说明" }];
const searched = (text = SEARCH_TEXT) => sse([...hostedItem(0, { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "q" } }),
  ...messageItem(1, text), completed]);
const models = () => openModels(env, codexStore());
const auditRows = (thread: string, kind: string) => runInDurableObject(env.THREAD.getByName(thread), (_instance, state) =>
  state.storage.sql.exec<{ detail: string }>("SELECT detail FROM events WHERE kind = ?", kind).toArray().map(row => JSON.parse(row.detail) as Record<string, unknown>));
async function modelView(): Promise<ModelView> {
  const response = await worker.fetch(new Request("https://test/admin/model", { headers: { Authorization: "Bearer test-admin-only" } }), { ...env, ADMIN_TOKEN: "test-admin-only" });
  return response.json<ModelView>();
}

describe("codexSearch", () => {
  it("asks the cheapest Codex model to run the hosted web_search and returns cleaned results", async () => {
    await codexLogin();
    const codex = fakeCodex(() => searched());
    expect(await codexSearch(models(), "durable objects 价格", { maxResults: 5 })).toEqual({ results: SEARCHED });
    expect(codex.bodies).toHaveLength(1);
    expect(codex.bodies[0]).toMatchObject({ model: "gpt-6-luna", tools: [{ type: "web_search" }] });
    expect(JSON.stringify(codex.bodies[0]!.input)).toContain("查询：durable objects 价格");
  });

  it("discards an answer that never called web_search", async () => {
    await codexLogin();
    fakeCodex(() => sse([...messageItem(0, SEARCH_TEXT), completed]));
    await expect(codexSearch(models(), "q", { maxResults: 5 })).rejects.toMatchObject({ code: "not_searched" });
  });

  it("reports login_required without calling Codex when ChatGPT is not logged in", async () => {
    const codex = fakeCodex(() => searched());
    await expect(codexSearch(models(), "q", { maxResults: 5 })).rejects.toMatchObject({ code: "login_required" });
    expect(codex.bodies).toHaveLength(0);
  });
});

describe("web_search tool", () => {
  it("answers a DeepSeek-style turn in the owner thread and audits only metadata", async () => {
    await codexLogin();
    const seen = scriptedModel([{ name: "web_search", args: { query: "秘密查询词", maxResults: 2 } }, { name: "", args: {} }]);
    fakeCodex(() => searched());
    expect(await env.THREAD.getByName("owner").submit(input(1, "帮我搜一下", 10000001))).toEqual({ status: "done" });
    expect(JSON.parse(seen.outputs[0]!)).toEqual({ results: SEARCHED });
    const audit = await auditRows("owner", "web_search");
    expect(audit).toEqual([{ result: "ok", results: 2, ms: expect.any(Number) }]);
    expect(JSON.stringify(audit)).not.toContain("秘密查询词");
  });

  it("is available to group members but generate_image is not", async () => {
    await codexLogin();
    const seen = scriptedModel([{ name: "web_search", args: { query: "q" } }, { name: "", args: {} }]);
    fakeCodex(() => searched());
    expect(await env.THREAD.getByName("group:200000001").submit(input(1, "搜一下", 10000003, 200000001, true))).toEqual({ status: "done" });
    expect(seen.requests[0]!.tools).toEqual(expect.arrayContaining(["web_search", "web_page"]));
    expect(seen.requests[0]!.tools).not.toContain("generate_image");
    expect(JSON.parse(seen.outputs[0]!)).toEqual({ results: SEARCHED });
  });

  it("tells the model the owner has not logged in to ChatGPT", async () => {
    const seen = scriptedModel([{ name: "web_search", args: { query: "q" } }, { name: "", args: {} }]);
    fakeCodex(() => searched());
    expect(await env.THREAD.getByName("owner").submit(input(1, "搜一下", 10000001))).toEqual({ status: "done" });
    expect(seen.outputs[0]).toContain("主人尚未登录 ChatGPT，无法联网搜索");
    expect(await auditRows("owner", "web_search")).toEqual([{ result: "login_required", results: 0, ms: expect.any(Number) }]);
  });
});

describe("generate_image tool", () => {
  const PNG = Buffer.from("synthetic-png-bytes").toString("base64");

  it("sends the generated image to the owner chat through NapCat and marks image generation available", async () => {
    await codexLogin();
    const { socket, frames } = await connect(sockets);
    const seen = scriptedModel([{ name: "generate_image", args: { prompt: "一只橘猫", size: "1024x1536" } }, { name: "", args: {} }]);
    const codex = fakeCodex(() => sse([...hostedItem(0, { type: "image_generation_call", id: "ig_1", status: "completed", result: PNG }), completed]));
    const running = env.THREAD.getByName("owner").submit(input(1, "画一只猫", 10000001));
    const frame = await action(frames, 0, "send_private_msg");
    expect(frame.params).toMatchObject({ user_id: "10000001", message: [{ type: "image", data: { file: `base64://${PNG}` } }] });
    reply(socket, frame.echo);
    expect(await running).toEqual({ status: "done" });
    expect(JSON.parse(seen.outputs[0]!)).toMatchObject({ status: "sent" });
    expect(codex.bodies[0]!.tools).toEqual([{ type: "image_generation", size: "1024x1536", quality: "medium" }]);
    expect((await modelView()).imageGeneration).toBe("available");
  });

  it("returns image_generation_unavailable when the backend rejects the hosted tool", async () => {
    await codexLogin();
    const { frames } = await connect(sockets);
    const seen = scriptedModel([{ name: "generate_image", args: { prompt: "一只橘猫" } }, { name: "", args: {} }]);
    fakeCodex(() => Response.json({ error: { message: "Tool 'image_generation' is not supported with this account", type: "invalid_request_error" } }, { status: 400 }));
    expect((await modelView()).imageGeneration).toBe("unknown");
    expect(await env.THREAD.getByName("owner").submit(input(1, "画一只猫", 10000001))).toEqual({ status: "done" });
    expect(seen.outputs[0]).toContain("image_generation_unavailable");
    expect(frames.some(frame => JSON.stringify(frame).includes("send_private_msg"))).toBe(false);
    expect((await modelView()).imageGeneration).toBe("unavailable");
  });
});

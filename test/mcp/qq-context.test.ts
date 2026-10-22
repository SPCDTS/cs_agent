import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { ThreadTokens, startMediaRecallServer } from "../../src/context/media-recall-server.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callQQContextTool } from "../../src/context/qq-context-tool.js";
import { ContextStore } from "../../src/context/store.js";
import type { Access } from "../../src/context/access.js";
import type { Channel, InboundMessage } from "../../src/channel/types.js";
import type { MediaRecall } from "../../src/context/media.js";
import { callBinding } from "../context/gateway-fixture.js";
import { tmp } from "../agent/helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ENTRY = path.join(ROOT, "dist", "mcp", "qq-context.js");
const G = "200000001";
let seq = 1;
function msg(text: string, o: Partial<InboundMessage> = {}): InboundMessage {
  return {
    message_id: String(seq++), time: Math.floor(Date.now() / 1000), message_type: "group", user_id: "20001",
    group_id: G, self_id: "10001", nickname: "De", text, route_text: text, truncated: false, mentioned_self: false,
    images: [], segments: [{ type: "text", data: { text } }], ...o,
  };
}

const clients: Client[] = [];
const closes: (() => Promise<void>)[] = [];
let writer: ContextStore | undefined;
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  for (const close of closes.splice(0)) await close();
  writer?.close();
  writer = undefined;
});

/**
 * 启动线程令牌端点并连接 qq_context 子进程：读取范围由主进程按会话当前回合求出（这里固定为 access；
 * undefined 表示调用不属于当前回合，网关拒绝）。
 */
async function connect(dataDir: string, access: Access | undefined,
  extra: { media?: Partial<Pick<MediaRecall, "recall" | "view">>; channel?: Pick<Channel, "listChats"> } = {}) {
  const tokens = new ThreadTokens({ recall: async () => ({ text: "ok", images: [] }), ...extra.media }, {
    resolve: async threadKey => {
      if (!access) throw new Error("本回合已结束，工具调用不再有效");
      return callBinding(threadKey, access, { turnId: "codex:mcp-turn", session: "thr-sess" });
    },
    send: async () => ({}),
  }, 5, extra.channel);
  const endpoint = await startMediaRecallServer(tokens, 0);
  closes.push(endpoint.close);
  const token = tokens.issue(`group:${G}`);
  const env: Record<string, string> = { DATA_DIR: dataDir, PATH: process.env.PATH ?? "", QQ_RECALL_TOKEN: token, MEDIA_RECALL_PORT: String(endpoint.port) };
  if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [ENTRY], env, stderr: "pipe" }));
  clients.push(client);
  return { client, revoke: () => tokens.revoke(`group:${G}`) };
}

const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content ?? []).map((c) => c.text).join("");
const scope: Access = { kind: "scope", scope: `group:${G}` };

describe("qq_context MCP over stdio (built dist)", () => {
  it("qq_chats 经线程令牌查询：范围由主进程求出，本会话范围拒绝，参数不能提升权限，作废后拒绝", async () => {
    const listChats = vi.fn(async () => ({ groups: [{ group_id: "7", name: "家庭群", member_count: 6 }], friends: [{ user_id: "1", nickname: "家人" }] }));
    const owner = await connect(tmp(), { kind: "all" }, { channel: { listChats } });
    expect(textOf(await owner.client.callTool({ name: "qq_chats", arguments: {} }))).toBe("group:7 家庭群（6 人）\nprivate:1 家人");
    expect(listChats).toHaveBeenCalledOnce(); listChats.mockClear();
    const group = await connect(tmp(), scope, { channel: { listChats } });
    expect((await group.client.callTool({ name: "qq_chats", arguments: {} })).isError).toBe(true);
    expect((await owner.client.callTool({ name: "qq_chats", arguments: { access: "all" } })).isError).toBe(true);
    owner.revoke();
    expect((await owner.client.callTool({ name: "qq_chats", arguments: {} })).isError).toBe(true);
    expect(listChats).not.toHaveBeenCalled();
  });
  it("qq_view_image 从 loopback 返回单张 MCP 图片，无本地媒体文件也可查看", async () => {
    const picture = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
    const c = await connect(tmp(), scope, { media: { view: async (access, file) => {
      expect(access).toEqual(scope);
      expect(file).toBe("/data/media/not-local.png"); return picture;
    } } });
    expect((await c.client.callTool({ name: "qq_view_image", arguments: { path: "/data/media/not-local.png" } })).content).toEqual([picture]);
    expect((await c.client.callTool({ name: "qq_view_image", arguments: { path: "/data/media/not-local.png", access: "all" } })).isError).toBe(true);
    c.revoke();
    expect((await c.client.callTool({ name: "qq_view_image", arguments: { path: "/data/media/not-local.png" } })).isError).toBe(true);
  });
  it("qq_image 经主进程 loopback 召回，MCP 无库也不创建文件", async () => {
    const c = await connect(tmp(), scope, { media: { recall: async (access, id) => ({ text: JSON.stringify({ access, id }), images: [] }) } });
    const result = await c.client.callTool({ name: "qq_image", arguments: { message_id: "123" } });
    expect(textOf(result)).toContain(`"scope":"group:${G}"`);
    expect(textOf(result)).toContain('"id":"123"');
    expect((result.content as { type: string }[]).every(c => c.type === "text")).toBe(true);
    c.revoke();
    expect((await c.client.callTool({ name: "qq_image", arguments: { message_id: "123" } })).isError).toBe(true);
  });
  it("lists the history and recall tools and serves recent / search / message within the scope resolved per call", async () => {
    const dir = tmp();
    writer = new ContextStore(dir);
    const quoted = msg("今晚有cs比赛吗", { message_id: "500" });
    writer.ingest(quoted);
    writer.ingest(msg("那明天呢", { message_id: "501", nickname: "小明", images: [], segments: [{ type: "reply", data: { id: "500" } }, { type: "text", data: { text: "那明天呢" } }] }));
    writer.ingest(msg("别的群也在聊比赛", { message_id: "502", group_id: "39999" }));

    const { client: c } = await connect(dir, scope);
    const tools = await c.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["qq_chats", "qq_image", "qq_message", "qq_recent", "qq_search", "qq_view_image"]);
    for (const t of tools.tools.filter(t => !["qq_image"].includes(t.name))) expect(t.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });

    const recent = textOf(await c.callTool({ name: "qq_recent", arguments: { limit: 30 } }));
    expect(recent.split("\n")).toEqual([expect.stringMatching(/^#500 \d\d:\d\d De: 今晚有cs比赛吗$/), expect.stringMatching(/^#501 \d\d:\d\d 小明: 那明天呢$/)]);
    const search = textOf(await c.callTool({ name: "qq_search", arguments: { query: "比赛", days: 30, limit: 20 } }));
    expect(search).toContain("今晚有cs比赛吗");
    expect(search).not.toContain("别的群");
    const one = textOf(await c.callTool({ name: "qq_message", arguments: { message_id: "501" } }));
    expect(one).toMatch(/小明: 那明天呢\n {2}↳ 引用 #500 \d\d:\d\d De: 今晚有cs比赛吗/);
    expect(textOf(await c.callTool({ name: "qq_message", arguments: { message_id: "502" } }))).toContain("不在当前会话范围内");
  });

  it("access=all sees every scope with scope labels", async () => {
    const dir = tmp();
    writer = new ContextStore(dir);
    writer.ingest(msg("本群", { message_id: "600" }));
    writer.ingest(msg("别群", { message_id: "601", group_id: "39999" }));
    const { client: c } = await connect(dir, { kind: "all" });
    const recent = textOf(await c.callTool({ name: "qq_recent", arguments: {} }));
    expect(recent).toContain(`[群${G}]`);
    expect(recent).toContain("[群39999]");
  });

  it("调用不属于会话当前回合（网关拒绝）→ 每个工具都返回错误文本，不泄露内容", async () => {
    const dir = tmp();
    writer = new ContextStore(dir);
    writer.ingest(msg("秘密"));
    const { client: c } = await connect(dir, undefined);
    for (const [name, args] of [["qq_recent", {}], ["qq_search", { query: "秘密" }], ["qq_message", { message_id: "1" }], ["qq_image", { message_id: "1" }]] as const) {
      const r = await c.callTool({ name, arguments: args });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain("本回合已结束");
      expect(textOf(r)).not.toContain("秘密");
    }
  });

  it("works when the writer has closed the database (read-only open of a checkpointed WAL db)", async () => {
    const dir = tmp();
    const w = new ContextStore(dir);
    w.ingest(msg("关闭后仍可读"));
    w.close();
    const { client: c } = await connect(dir, scope);
    expect(textOf(await c.callTool({ name: "qq_recent", arguments: {} }))).toContain("关闭后仍可读");
  });

  it("missing database file → error text, not a crash", async () => {
    const { client: c } = await connect(path.join(tmp(), "nothing"), scope);
    const r = await c.callTool({ name: "qq_recent", arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("消息库无法打开");
  });
});

describe("callQQContextTool caps", () => {
  it("clamps limits and applies the total character cap", () => {
    const dir = tmp();
    writer = new ContextStore(dir);
    for (let i = 0; i < 60; i++) writer.ingest(msg(`第${i}条 ` + "字".repeat(200), { message_id: String(1000 + i), time: 1_800_000_000 + i }));
    const deps = { access: { kind: "scope", scope: `group:${G}` } as const, openStore: () => writer!, maxChars: 2500 };
    const out = callQQContextTool(deps, "qq_recent", { limit: 999 });
    const text = (out.content[0] as { text: string }).text;
    expect(text.length).toBeLessThanOrEqual(2500);
    expect(text).toContain("第59条");
    expect(text).not.toContain("第29条"); // limit 被夹到 30
    const s = callQQContextTool(deps, "qq_search", { query: "字", days: 9999, limit: 999 });
    expect((s.content[0] as { text: string }).text.split("\n").length).toBeLessThanOrEqual(21);
    expect(callQQContextTool(deps, "qq_search", { query: "  " }).isError).toBe(true);
  });
});

it("独立 MCP 按本次调用的回合与线程写入召回归属，观测库不可写不影响工具", async () => {
  for (const blocked of [false, true]) {
    const dir = tmp(); writer = new ContextStore(dir); writer.ingest(msg("独立进程历史"));
    if (blocked) mkdirSync(path.join(dir, "observability.sqlite"));
    const { client: c } = await connect(dir, scope);
    expect(textOf(await c.callTool({ name: "qq_recent", arguments: {} }))).toContain("独立进程历史");
    if (!blocked) {
      const db = new DatabaseSync(path.join(dir, "observability.sqlite"), { readOnly: true });
      try { expect(db.prepare('SELECT * FROM recall_events').get()).toMatchObject({ backend: 'codex', turn_id: 'codex:mcp-turn', session: 'thr-sess', returned_count: 1 }); }
      finally { db.close(); }
    }
    await c.close(); writer.close(); writer = undefined;
  }
});

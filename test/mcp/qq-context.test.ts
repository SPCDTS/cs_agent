import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { RecallTokens, startMediaRecallServer } from "../../src/context/media-recall-server.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { callQQContextTool } from "../../src/mcp/qq-context-server.js";
import { ContextStore } from "../../src/context/store.js";
import type { InboundMessage } from "../../src/qq/types.js";
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
let writer: ContextStore | undefined;
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  writer?.close();
  writer = undefined;
});

async function connect(dataDir: string, access: string | undefined, extra: Record<string, string> = {}): Promise<Client> {
  const env: Record<string, string> = { ...extra, DATA_DIR: dataDir, PATH: process.env.PATH ?? "" };
  if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  if (access !== undefined) env.QQ_ACCESS = access;
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [ENTRY], env, stderr: "pipe" }));
  clients.push(client);
  return client;
}

const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content ?? []).map((c) => c.text).join("");

describe("qq_context MCP over stdio (built dist)", () => {
  it("qq_view_image 从 loopback 返回单张 MCP 图片，无本地媒体文件也可查看", async () => {
    const picture = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
    const tokens = new RecallTokens({ recall: async () => ({ text: "ok", images: [] }),
      view: async (access, file) => {
        expect(access).toEqual({ kind: "scope", scope: "group:7" });
        expect(file).toBe("/data/media/not-local.png"); return picture;
      } });
    const endpoint = await startMediaRecallServer(tokens, 0);
    const lease = tokens.issue({ access: { kind: "scope", scope: "group:7" }, ticket: "view", deadline: Date.now() + 60_000 });
    try {
      const c = await connect(tmp(), "group:7", { QQ_RECALL_TOKEN: lease.token, MEDIA_RECALL_PORT: String(endpoint.port) });
      expect((await c.callTool({ name: "qq_view_image", arguments: { path: "/data/media/not-local.png" } })).content).toEqual([picture]);
      expect((await c.callTool({ name: "qq_view_image", arguments: { path: "/data/media/not-local.png", access: "all" } })).isError).toBe(true);
      lease.revoke();
      expect((await c.callTool({ name: "qq_view_image", arguments: { path: "/data/media/not-local.png" } })).isError).toBe(true);
    } finally { await endpoint.close(); }
  });
  it("qq_image 经主进程 loopback 召回，MCP 无库也不创建文件", async () => {
    const tokens = new RecallTokens({ recall: async (access, id) => ({ text: JSON.stringify({ access, id }), images: [] }) });
    const endpoint = await startMediaRecallServer(tokens, 0);
    const lease = tokens.issue({ access: { kind: "scope", scope: "group:7" }, ticket: "tk", deadline: Date.now() + 60_000 });
    try {
      const c = await connect(tmp(), "group:7", { QQ_RECALL_TOKEN: lease.token, MEDIA_RECALL_PORT: String(endpoint.port) });
      const result = await c.callTool({ name: "qq_image", arguments: { message_id: "123" } });
      expect(textOf(result)).toContain('"scope":"group:7"');
      expect(textOf(result)).toContain('"id":"123"');
      expect((result.content as { type: string }[]).every(c => c.type === "text")).toBe(true);
      lease.revoke();
      expect((await c.callTool({ name: "qq_image", arguments: { message_id: "123" } })).isError).toBe(true);
    } finally { await endpoint.close(); }
  });
  it("lists the history and recall tools and serves recent / search / message within the injected scope", async () => {
    const dir = tmp();
    writer = new ContextStore(dir);
    const quoted = msg("今晚有cs比赛吗", { message_id: "500" });
    writer.ingest(quoted);
    writer.ingest(msg("那明天呢", { message_id: "501", nickname: "小明", images: [], segments: [{ type: "reply", data: { id: "500" } }, { type: "text", data: { text: "那明天呢" } }] }));
    writer.ingest(msg("别的群也在聊比赛", { message_id: "502", group_id: "39999" }));

    const c = await connect(dir, `group:${G}`);
    const tools = await c.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["qq_image", "qq_message", "qq_recent", "qq_search", "qq_view_image"]);
    for (const t of tools.tools.filter(t => t.name !== "qq_image")) expect(t.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });

    const recent = textOf(await c.callTool({ name: "qq_recent", arguments: { limit: 30 } }));
    expect(recent.split("\n")).toEqual([expect.stringMatching(/^#500 \d\d:\d\d De: 今晚有cs比赛吗$/), expect.stringMatching(/^#501 \d\d:\d\d 小明: 那明天呢$/)]);
    const search = textOf(await c.callTool({ name: "qq_search", arguments: { query: "比赛", days: 30, limit: 20 } }));
    expect(search).toContain("今晚有cs比赛吗");
    expect(search).not.toContain("别的群");
    const one = textOf(await c.callTool({ name: "qq_message", arguments: { message_id: "501" } }));
    expect(one).toMatch(/小明: 那明天呢\n {2}↳ 引用 #500 \d\d:\d\d De: 今晚有cs比赛吗/);
    expect(textOf(await c.callTool({ name: "qq_message", arguments: { message_id: "502" } }))).toContain("不在当前会话范围内");
  });

  it("QQ_ACCESS=all sees every scope with scope labels", async () => {
    const dir = tmp();
    writer = new ContextStore(dir);
    writer.ingest(msg("本群", { message_id: "600" }));
    writer.ingest(msg("别群", { message_id: "601", group_id: "39999" }));
    const c = await connect(dir, "all");
    const recent = textOf(await c.callTool({ name: "qq_recent", arguments: {} }));
    expect(recent).toContain(`[群${G}]`);
    expect(recent).toContain("[群39999]");
  });

  it("missing or invalid QQ_ACCESS → every tool returns an error text", async () => {
    const dir = tmp();
    writer = new ContextStore(dir);
    writer.ingest(msg("秘密"));
    for (const access of [undefined, "everyone"]) {
      const c = await connect(dir, access);
      for (const [name, args] of [["qq_recent", {}], ["qq_search", { query: "秘密" }], ["qq_message", { message_id: "1" }]] as const) {
        const r = await c.callTool({ name, arguments: args });
        expect(r.isError).toBe(true);
        expect(textOf(r)).toContain("QQ_ACCESS");
        expect(textOf(r)).not.toContain("秘密");
      }
    }
  });

  it("works when the writer has closed the database (read-only open of a checkpointed WAL db)", async () => {
    const dir = tmp();
    const w = new ContextStore(dir);
    w.ingest(msg("关闭后仍可读"));
    w.close();
    const c = await connect(dir, `group:${G}`);
    expect(textOf(await c.callTool({ name: "qq_recent", arguments: {} }))).toContain("关闭后仍可读");
  });

  it("missing database file → error text, not a crash", async () => {
    const c = await connect(path.join(tmp(), "nothing"), `group:${G}`);
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

it("独立 MCP 写入召回归属，空 session 存 NULL，观测库不可写不影响工具", async () => {
  for (const blocked of [false, true]) {
    const dir = tmp(); writer = new ContextStore(dir); writer.ingest(msg("独立进程历史"));
    if (blocked) mkdirSync(path.join(dir, "observability.sqlite"));
    const c = await connect(dir, `group:${G}`, { QQ_TICKET: "mcp-ticket", QQ_BACKEND: "codex", QQ_SESSION: "" });
    expect(textOf(await c.callTool({ name: "qq_recent", arguments: {} }))).toContain("独立进程历史");
    if (!blocked) {
      const db = new DatabaseSync(path.join(dir, "observability.sqlite"), { readOnly: true });
      try { expect(db.prepare('SELECT * FROM recall_events').get()).toMatchObject({ backend: 'codex', ticket: 'mcp-ticket', session: null, returned_count: 1 }); }
      finally { db.close(); }
    }
    await c.close(); writer.close(); writer = undefined;
  }
});

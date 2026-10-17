import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { callQQContextTool } from "../../src/mcp/qq-context-server.js";
import { ContextStore } from "../../src/context/store.js";
import type { InboundMessage } from "../../src/qq/types.js";
import { tmp } from "../agent/helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ENTRY = path.join(ROOT, "dist", "mcp", "qq-context.js");
const G = "200000001";

/** dist 缺失或比源码旧时先编译（stdio 测试跑的是构建产物，与容器内一致）。 */
beforeAll(() => {
  const srcs = ["src/mcp/qq-context.ts", "src/mcp/qq-context-server.ts", "src/context/store.ts", "src/context/format.ts", "src/context/access.ts"];
  const newest = Math.max(...srcs.map((f) => statSync(path.join(ROOT, f)).mtimeMs));
  if (existsSync(ENTRY) && statSync(ENTRY).mtimeMs >= newest) return;
  const tsc = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
  const r = spawnSync(process.execPath, [tsc, "-p", "tsconfig.json"], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`build failed: ${r.stdout}${r.stderr}`);
}, 120_000);

let seq = 1;
function msg(text: string, o: Partial<InboundMessage> = {}): InboundMessage {
  return {
    message_id: String(seq++), time: Math.floor(Date.now() / 1000), message_type: "group", user_id: "20001",
    group_id: G, self_id: "10001", nickname: "De", text, truncated: false, mentioned_self: false,
    segments: [{ type: "text", data: { text } }], ...o,
  };
}

const clients: Client[] = [];
let writer: ContextStore | undefined;
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  writer?.close();
  writer = undefined;
});

async function connect(dataDir: string, access: string | undefined): Promise<Client> {
  const env: Record<string, string> = { DATA_DIR: dataDir, PATH: process.env.PATH ?? "" };
  if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  if (access !== undefined) env.QQ_ACCESS = access;
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [ENTRY], env, stderr: "pipe" }));
  clients.push(client);
  return client;
}

const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content ?? []).map((c) => c.text).join("");

describe("qq_context MCP over stdio (built dist)", () => {
  it("lists the three tools and serves recent / search / message within the injected scope", async () => {
    const dir = tmp();
    writer = new ContextStore(dir);
    const quoted = msg("今晚有cs比赛吗", { message_id: "500" });
    writer.ingest(quoted);
    writer.ingest(msg("那明天呢", { message_id: "501", nickname: "小明", segments: [{ type: "reply", data: { id: "500" } }, { type: "text", data: { text: "那明天呢" } }] }));
    writer.ingest(msg("别的群也在聊比赛", { message_id: "502", group_id: "39999" }));

    const c = await connect(dir, `group:${G}`);
    const tools = await c.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["qq_message", "qq_recent", "qq_search"]);

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

import { createServer } from "node:http";
import path from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels, fauxProvider, Type, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { AgentDoc, createRegistry, defineExtension, defineTool, Harness, ToolResultEntry, type Conversation, type JsonObject } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiMcp } from "../../src/agent/pi-mcp/index.js";
import { McpCatalogsDoc, digest, toolNames } from "../../src/agent/pi-mcp/catalog.js";
import { parseMcpConfig, type McpConfigState } from "../../src/agent/pi-mcp/config.js";
import type { PiCallBinding } from "../../src/agent/pi-tools/request.js";
import { call, reply } from "./faux-helpers.js";
import { tmp } from "./helpers.js";

const context = BACKGROUND_CONTEXT;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const owner = (): PiCallBinding => ({ threadKey: "owner", scope: "private:123", identity: { kind: "user", sender: "123" },
  inputs: [], access: "all", senderIsOwner: true, auth: true, child: false });

/** 可改变目录且可挂起业务请求的真实 HTTP 服务，计数器只在服务收到请求时增加。 */
async function server() {
  const state = { calls: 0, lists: 0, sessions: 0, active: 0, peak: 0, deletes: 0, deleteDelay: 0, version: 1, otherVersion: 1, description: "", hang: false, notify: false };
  const http = createServer(async (req, res) => {
    req.on("error", () => {}); res.on("error", () => {});
    if (req.method === "GET") { res.writeHead(405).end(); return; }
    if (req.method === "DELETE") {
      if (state.deleteDelay) await new Promise(resolve => setTimeout(resolve, state.deleteDelay));
      state.deletes++; state.active--; res.writeHead(202).end(); return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const message = JSONRPCMessageSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
    if (!("id" in message) || !("method" in message)) { res.writeHead(202).end(); return; }
    let result: unknown;
    if (message.method === "initialize") {
      res.setHeader("mcp-session-id", `session-${++state.sessions}`);
      state.active++; state.peak = Math.max(state.peak, state.active);
      result = { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "fixture", version: "1" } };
    } else if (message.method === "tools/list") {
      state.lists++;
      result = { tools: ["lookup", "hidden", "other"].map(name => ({ name, description: state.description || `版本 ${state.version}`,
        inputSchema: { type: "object", properties: { value: { type: "integer", minimum: name === "other" ? state.otherVersion : state.version,
          description: state.description } }, required: ["value"], additionalProperties: false },
        outputSchema: { type: "object", properties: { value: { type: "integer" } }, required: ["value"] } })) };
    } else if (message.method === "tools/call") {
      state.calls++;
      if (state.hang) return;
      result = { content: [{ type: "text", text: "执行成功" }], structuredContent: { value: state.calls } };
      if (state.notify) {
        state.version++; state.notify = false;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`);
        res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`); return;
      }
    } else { res.writeHead(202).end(); return; }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("address");
  cleanup.push(async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); });
  const config = (limits: object = {}, access: object = {}, allow = ["lookup"]): McpConfigState => parseMcpConfig({ version: 1, enabled: true, limits,
    servers: [{ id: "fixture", transport: { kind: "streamable-http", url: `http://127.0.0.1:${address.port}/mcp`, allowLoopbackHttp: true },
      credential: { kind: "none" }, tools: { allow }, access: { kind: "owner-private", ...access }, replay: "unsafe" }] });
  return { state, config };
}

async function rig(config: McpConfigState, db = path.join(tmp("cs-pi-mcp-"), "pi.sqlite")) {
  const faux = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: Infinity });
  const requests: string[] = [];
  let selected = "";
  let argumentsValue: JsonObject = { value: 1 };
  const step: FauxResponseFactory = ctx => {
    requests.push(JSON.stringify(ctx.messages));
    return ctx.messages.findLast(message => message.role !== "system")?.role === "toolResult" ? reply() : call([selected, argumentsValue]);
  };
  faux.setResponses(Array.from({ length: 100 }, () => step));
  const models = createModels(); models.setProvider(faux.provider);
  const registry = createRegistry();
  const base = defineExtension({ name: "base", tools: [defineTool({ name: "local", description: "本地工具", parameters: Type.Object({}),
    execute: async () => ({ output: [{ type: "text", text: "本地" }] }) })] });
  registry.install(base);
  const harness = await Harness.open(await openNodeSqliteStorage(db), { models, registry,
    settings: { extensions: [base], toolExecution: "sequential", retry: { maxRetries: 0 } } }, context);
  const bindings = new Map<number, PiCallBinding>();
  let owners = ["123"];
  const mcp = await PiMcp.attach({ registry, harness, config, secrets: { readReferencedVariable: () => undefined }, owners: () => owners,
    binding: async id => bindings.get(id), workspaceDir: () => path.dirname(db) });
  let closed = false;
  const close = async () => { if (closed) return; closed = true; mcp.beginShutdown(); await harness.close(context); await mcp.close(); };
  cleanup.push(close);
  const create = async (binding = owner()) => {
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: faux.getModel().provider, modelId: "test" } } }, context);
    bindings.set(Number(conv.id), binding); return conv;
  };
  const configure = (conversation: Conversation, ctx = context) => mcp.configure({ conversation, turn: bindings.get(Number(conversation.id))! }, ctx);
  const run = async (conv: Conversation, name: string, args: JsonObject = { value: 1 }) => {
    selected = name; argumentsValue = args;
    return (await conv.submit({ type: "input", content: "执行一次" }, context)).wait(context);
  };
  return { mcp, harness, registry, db, bindings, create, configure, run, close, requests, revoke: () => { owners = []; } };
}
const names = async (conv: Conversation) => (await conv.agent(context)).tools.map(t => t.name);
const mcpNames = async (conv: Conversation) => (await names(conv)).filter(n => n.startsWith("mcp_") && n !== "mcp_refresh_tools");
const results = async (conv: Conversation) => (await conv.entries({ order: "ascending" }, 1000, undefined, context)).items.filter(ToolResultEntry.is);

describe("Pi MCP 原生工具与持久目录", () => {
  it("保留原扩展、精确 allowlist、unsafe 原生调用与结构化结果", async () => {
    const s = await server(), r = await rig(s.config()), c = await r.create();
    await r.configure(c);
    expect(await names(c)).toEqual(["local", "mcp_refresh_tools", expect.stringMatching(/^mcp_fixture_lookup_\w+$/)]);
    const [name] = await mcpNames(c);
    expect(r.registry.snapshot().tools().find(t => t.tool.name === name)!.tool.replay).toBe("unsafe");
    expect(await r.run(c, name!)).toMatchObject({ status: "done" });
    expect(s.state.calls).toBe(1);
    expect((await results(c))[0]?.model?.[0]).toMatchObject({ role: "toolResult", isError: false });
    expect(JSON.stringify((await results(c))[0]?.model)).toContain('\\"value\\":1');
    expect(Object.values((await r.harness.snapshot(McpCatalogsDoc, context))!.revisions)).toHaveLength(1);
  });

  it.each([
    { identity: { kind: "user", sender: "456" } },
    { threadKey: "group:123", scope: "group:123" },
    { child: true },
    { identity: { kind: "scheduled", creator: "123" } },
    { identity: { kind: "wake" } },
    { identity: { kind: "wake", inherited: { kind: "user", person: "123", owner: true } } },
  ] satisfies Partial<PiCallBinding>[]) ("无授权身份不发现、不建连接：%j", async patch => {
    const s = await server(), r = await rig(s.config()), c = await r.create({ ...owner(), ...patch });
    await r.configure(c);
    expect(await names(c)).toEqual(["local"]);
    expect(s.state.sessions).toBe(0);
  });

  it("显式允许 scheduled/wake，未知继承仍关闭", async () => {
    const s = await server(), r = await rig(s.config({}, { allowScheduled: true, allowWake: true }));
    const c = await r.create({ ...owner(), identity: { kind: "wake", inherited: { kind: "scheduled", person: "123", owner: true } } });
    await r.configure(c); expect(await mcpNames(c)).toHaveLength(1);
    r.bindings.set(Number(c.id), { ...owner(), identity: { kind: "wake" } });
    await r.configure(c); expect(await mcpNames(c)).toHaveLength(0);
  });

  it("描述正文与 schema 一同受模型工具定义预算限制", async () => {
    const s = await server(), r = await rig(s.config({ visibleSchemaBytes: 512 })), c = await r.create();
    s.state.description = "很长的远端工具描述".repeat(100);
    await r.configure(c); expect(await mcpNames(c)).toHaveLength(0); expect(s.state.calls).toBe(0);
  });

  it("发现后撤销 owner，历史工具调用也不能发送", async () => {
    const s = await server(), r = await rig(s.config()), c = await r.create();
    await r.configure(c); const [name] = await mcpNames(c);
    r.revoke(); await r.run(c, name!);
    expect(s.state.calls).toBe(0);
    expect((await results(c))[0]?.data?.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "mcp_denied" })]));
  });

  it("实际执行绑定变成 child，即使伪造旧工具名也拒绝", async () => {
    const s = await server(), r = await rig(s.config()), c = await r.create();
    await r.configure(c); const [name] = await mcpNames(c);
    r.bindings.set(Number(c.id), { ...owner(), child: true });
    await r.run(c, name!); expect(s.state.calls).toBe(0);
  });

  it("不同会话分别初始化，目录名字也不混用", async () => {
    const s = await server(), r = await rig(s.config()), a = await r.create(), b = await r.create();
    await Promise.all([r.configure(a), r.configure(b)]);
    expect(s.state.sessions).toBe(2);
    expect(await mcpNames(a)).not.toEqual(await mcpNames(b));
    await r.close(); expect(s.state.deletes).toBe(2);
  });

  it("并发首次发现受连接容量约束，关闭没有游离连接", async () => {
    const s = await server(), r = await rig(s.config({ connections: 1 })), a = await r.create(), b = await r.create();
    await Promise.all([r.configure(a), r.configure(b)]);
    expect(s.state.sessions).toBe(1);
    expect([...(await mcpNames(a)), ...(await mcpNames(b))]).toHaveLength(1);
    await r.close(); expect(s.state.deletes).toBe(1);
  });

  it("list_changed 在工具轮结束后替换选择，旧定义仍留存", async () => {
    const s = await server(), r = await rig(s.config()), c = await r.create();
    await r.configure(c); const [first] = await mcpNames(c);
    s.state.notify = true; await r.run(c, first!);
    const [second] = await mcpNames(c);
    expect(second).not.toBe(first); expect(s.state.calls).toBe(1); expect(s.state.lists).toBe(2);
    expect(r.mcp.toolIdentity(first!)).toBeDefined();
    expect(Object.values((await r.harness.snapshot(McpCatalogsDoc, context))!.revisions)).toHaveLength(2);
  });

  it("TTL 更新发现旧 schema/目录，阻止已经排好的旧工具调用", async () => {
    const s = await server(), r = await rig(s.config({ catalogTtlMs: 1 })), c = await r.create();
    await r.configure(c); const [name] = await mcpNames(c); s.state.version++;
    await new Promise(resolve => setTimeout(resolve, 5));
    await r.run(c, name!); expect(s.state.calls).toBe(0);
    expect((await results(c))[0]?.data?.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "mcp_tool_retired" })]));
    expect(r.requests.at(-1)).toContain("not_started");
    expect(r.requests.at(-1)).toContain((await mcpNames(c))[0]);
    expect(JSON.stringify(await results(c))).not.toContain("MCP 工具版本提示");
  });

  it("无关工具变更不影响已排队的工具，复用扩展并更新描述", async () => {
    const s = await server(), r = await rig(s.config({ catalogTtlMs: 1 }, {}, ["lookup", "other"])), c = await r.create();
    await r.configure(c);
    const before = await mcpNames(c), lookup = before.find(name => name.includes("_lookup_"))!;
    s.state.otherVersion++; s.state.description = "更新后的描述";
    await new Promise(resolve => setTimeout(resolve, 5));
    await r.run(c, lookup);
    expect(s.state.calls).toBe(1);
    expect(await mcpNames(c)).toContain(lookup);
    expect(await mcpNames(c)).not.toEqual(before);
    expect((await c.agent(context)).tools.find(tool => tool.name === lookup)?.description).toContain("更新后的描述");
    expect(r.registry.snapshot().tools().filter(item => item.tool.name === lookup)).toHaveLength(1);
    expect(r.requests.some(request => request.includes("更新后的描述"))).toBe(true);
    const revisions = Object.values((await r.harness.snapshot(McpCatalogsDoc, context))!.revisions);
    expect(r.mcp.toolIdentity(lookup)?.catalogDigest).toBe(revisions.at(-1)?.digest);
  });

  it("历史旧名称得到当前工具提示，但远端未执行且原日志不变", async () => {
    const s = await server(), r = await rig(s.config()), c = await r.create();
    await r.configure(c); const [old] = await mcpNames(c);
    s.state.version++;
    await r.mcp.configure({ conversation: c, turn: owner(), refresh: true }, context);
    const [current] = await mcpNames(c);
    await r.run(c, old!);
    expect(s.state.calls).toBe(0);
    expect((await results(c))[0]?.data?.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "tool_unavailable" })]));
    expect(r.requests.at(-1)).toContain("not_started");
    expect(r.requests.at(-1)).toContain(current);
    expect(JSON.stringify(await results(c))).not.toContain("not_started");
  });

  it("旧名称提示不跨会话传播，也不在撤权后泄露新定义", async () => {
    const s = await server(), r = await rig(s.config()), a = await r.create(), b = await r.create();
    await r.configure(a); await r.configure(b);
    const [foreign] = await mcpNames(a);
    await r.run(b, foreign!);
    expect(r.requests.at(-1)).not.toContain("MCP 工具版本提示");
    s.state.version++;
    await r.mcp.configure({ conversation: a, turn: owner(), refresh: true }, context);
    r.revoke(); await r.run(a, foreign!);
    expect(r.requests.at(-1)).not.toContain("MCP 工具版本提示");
    expect(s.state.calls).toBe(0);
  });

  it("显式刷新仅发现目录，不调用远端业务工具", async () => {
    const s = await server(), r = await rig(s.config()), c = await r.create();
    await r.configure(c); const before = await mcpNames(c), listed = s.state.lists;
    s.state.version++;
    await r.run(c, "mcp_refresh_tools", {});
    expect(s.state.calls).toBe(0); expect(s.state.lists).toBe(listed + 1);
    expect(await mcpNames(c)).not.toEqual(before);
  });

  it("真实 v1 SQLite 升级识别旧调用，不能把新名称套到历史目录", async () => {
    const s = await server(), first = await rig(s.config()), c = await first.create();
    await first.configure(c);
    const original = Object.values((await first.harness.snapshot(McpCatalogsDoc, context))!.revisions)[0]!;
    const { digest: _ignored, ...payload } = original;
    const legacy = { ...payload, adapterVersion: 1 as const };
    const revision = { ...legacy, digest: digest(legacy) }, tool = revision.tools[0]!;
    const old = toolNames(revision, tool);
    await first.harness.commit(async tx => {
      (await tx.doc(McpCatalogsDoc)).revisions = { [revision.digest]: revision };
      (await tx.doc(AgentDoc, c.id)).extensions = ["base", "cs.mcp.control", old.extensionName];
    }, context);
    const id = c.id; await first.close();
    const second = await rig(s.config(), first.db), restored = (await second.harness.conversation(id, context))!;
    second.bindings.set(Number(id), owner());
    expect(await mcpNames(restored)).toEqual([old.nativeName]);
    await second.configure(restored); expect(await mcpNames(restored)).not.toContain(old.nativeName);
    await second.run(restored, old.nativeName);
    expect(s.state.calls).toBe(0); expect(second.requests.at(-1)).toContain("not_started");
  });

  it("超时报告 outcome_unknown，不重发业务请求", async () => {
    const s = await server(), r = await rig(s.config({ callMs: 300 })), c = await r.create();
    await r.configure(c); const [name] = await mcpNames(c); s.state.hang = true;
    await r.run(c, name!); expect(s.state.calls).toBe(1);
    expect((await results(c))[0]?.data?.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "mcp_outcome_unknown" })]));
    expect(r.requests.at(-1)).not.toContain("MCP 工具版本提示");
  });

  it("故障后同会话重连等待旧连接关闭，不绕过连接上限", async () => {
    const s = await server(), r = await rig(s.config({ callMs: 500, connections: 1 })), c = await r.create();
    await r.configure(c); const [name] = await mcpNames(c);
    s.state.hang = true; s.state.deleteDelay = 100;
    await r.run(c, name!);
    expect(s.state.sessions).toBe(2); expect(s.state.peak).toBe(1); expect(s.state.calls).toBe(1);
  });

  it("排队发现被取消后不再刷新目录", async () => {
    const s = await server(), r = await rig(s.config({ catalogTtlMs: 1, callMs: 500 })), c = await r.create();
    await r.configure(c); const [name] = await mcpNames(c); s.state.hang = true;
    const running = r.run(c, name!);
    await vi.waitFor(() => expect(s.state.calls).toBe(1));
    const controller = new AbortController();
    const queued = r.configure(c, withAbortSignal(controller.signal, context));
    controller.abort(); await expect(queued).rejects.toThrow();
    await running;
    // 首次发现 + 执行前TTL复查 + afterTools刷新；取消的队列项未执行。
    expect(s.state.lists).toBe(3);
  });

  it("重启先从 pi.sqlite 恢复同名定义，禁用配置不外连且拒绝旧调用", async () => {
    const s = await server(), first = await rig(s.config()), c = await first.create();
    await first.configure(c); const [name] = await mcpNames(c), id = c.id;
    await first.close(); const connects = s.state.sessions;
    const second = await rig({ kind: "disabled", reason: "停用" }, first.db);
    const restored = (await second.harness.conversation(id, context))!;
    second.bindings.set(Number(id), owner());
    expect(await mcpNames(restored)).toEqual([name]); expect(s.state.sessions).toBe(connects);
    await second.run(restored, name!); expect(s.state.calls).toBe(0);
    expect((await results(restored))[0]?.data?.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "mcp_denied" })]));
  });

  it("更新 MCP 选择保留已有 add/remove 内容", async () => {
    const s = await server(), r = await rig(s.config()), c = await r.create();
    await r.harness.commit(async tx => { (await tx.doc(AgentDoc, c.id)).extensions = { add: ["base"], remove: ["im.targeted"] }; }, context);
    await r.configure(c); const doc = await r.harness.snapshot(AgentDoc, c.id, context);
    expect(doc?.extensions).toMatchObject({ add: expect.arrayContaining(["base"]), remove: ["im.targeted"] });
  });

  it("损坏目录独立隔离，不消耗后续正常目录恢复额度", async () => {
    const s = await server(), config = s.config({ retainedRevisions: 1 }), first = await rig(config), c = await first.create();
    await first.configure(c); const [name] = await mcpNames(c), id = c.id;
    await first.harness.commit(async tx => {
      const doc = await tx.doc(McpCatalogsDoc), valid = Object.values(doc.revisions)[0]!;
      doc.revisions = { invalid: { ...valid, digest: "invalid" }, [valid.digest]: valid };
    }, context);
    await first.close(); const count = s.state.sessions;
    const second = await rig(config, first.db), restored = (await second.harness.conversation(id, context))!;
    expect(await mcpNames(restored)).toEqual([name]); expect(s.state.sessions).toBe(count);
  });
});

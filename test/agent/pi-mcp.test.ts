import { createServer } from "node:http";
import path from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels, fauxProvider, Type, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { AgentDoc, createRegistry, defineExtension, defineTool, Harness, ToolResultEntry, watchEvents, type Conversation, type JsonObject } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpDelegationDoc } from "../../src/agent/pi-mcp/delegation.js";
import { resourceResponse } from "./fixtures/pi-mcp-http.js";
import { isMcpControlTool } from "../../src/agent/pi-mcp/names.js";
import { runRights } from "../../src/agent/host/identity.js";
import { PiMcp } from "../../src/agent/pi-mcp/index.js";
import { McpCatalogsDoc, digest } from "../../src/agent/pi-mcp/catalog.js";
import { parseMcpConfig, type McpConfigState } from "../../src/agent/pi-mcp/config.js";
import type { PiCallBinding } from "../../src/agent/pi-tools/request.js";
import { trace } from "../../src/shared/trace.js";
import { call, reply } from "./faux-helpers.js";
import { tmp } from "./helpers.js";

const context = BACKGROUND_CONTEXT;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const owner = (): PiCallBinding => ({ threadKey: "owner", scope: "private:123", identity: { kind: "user", sender: "123" },
  inputs: [], access: "all", senderIsOwner: true, auth: true, child: false });

/** 可改变目录且可挂起业务请求的真实 HTTP 服务，计数器只在服务收到请求时增加。 */
async function server() {
  const state = { calls: 0, lists: 0, sessions: 0, active: 0, peak: 0, deletes: 0, deleteDelay: 0, version: 1, otherVersion: 1, description: "", hang: false, notify: false, resources: true, resourceReads: 0, resourceLists: 0, templateLists: 0, resourceHang: false };
  const holds = new Map<string, Promise<void>>();
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
      await holds.get(message.method);
      result = { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true }, ...state.resources ? { resources: {} } : {} }, serverInfo: { name: "fixture", version: "1" } };
    } else if (message.method === "tools/list") {
      state.lists++;
      await holds.get(message.method);
      result = { tools: ["lookup", "hidden", "other"].map(name => ({ name, description: state.description || `版本 ${state.version}`,
        inputSchema: { type: "object", properties: { value: { type: "integer", minimum: name === "other" ? state.otherVersion : state.version,
          description: state.description } }, required: ["value"], additionalProperties: false },
        outputSchema: { type: "object", properties: { value: { type: "integer" } }, required: ["value"] } })) };
    } else if (message.method.startsWith("resources/")) {
      if (message.method === "resources/read") state.resourceReads++;
      else if (message.method === "resources/list") state.resourceLists++;
      else state.templateLists++;
      if (state.resourceHang) return;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id,
        ...resourceResponse(message.method, message.params) })); return;
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
  const config = (limits: object = {}, access: object = {}, allow = ["lookup"], resources: string[] = []): McpConfigState => parseMcpConfig({ version: 1, enabled: true, limits,
    servers: [{ id: "fixture", transport: { kind: "streamable-http", url: `http://127.0.0.1:${address.port}/mcp`, allowLoopbackHttp: true },
      credential: { kind: "none" }, tools: { allow }, resources: { allow: resources }, access: { kind: "owner-private", ...access }, replay: "unsafe" }] });
  return { state, config, hold(method: "initialize" | "tools/list") {
    let release = () => {};
    holds.set(method, new Promise<void>(resolve => { release = resolve; }));
    return () => { holds.delete(method); release(); };
  } };
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
  // nested 走 codemode 同一条嵌套调用路径（executeTool），把嵌套结果原样交回，便于直接断言诊断码。
  const base = defineExtension({ name: "base", tools: [defineTool({ name: "local", description: "本地工具", parameters: Type.Object({}), callers: ["model"],
    execute: async () => ({ output: [{ type: "text", text: "本地" }] }) }),
  defineTool({ name: "nested", description: "嵌套调用", parameters: Type.Object({ name: Type.String(), args: Type.Record(Type.String(), Type.Unknown()) }), callers: ["model"],
    execute: async ({ name, args }, api, ctx) => {
      const result = await api.executeTool(name, args as JsonObject, ctx);
      const value = result.structuredOutput;
      return { isError: result.isError, diagnostics: [...result.diagnostics],
        output: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value ?? "") }] };
    } })] });
  registry.install(base);
  const storage = await openNodeSqliteStorage(db);
  const harness = await Harness.open(storage, { models, registry,
    settings: { extensions: [base], toolExecution: "sequential", retry: { maxRetries: 0 } } }, context);
  const bindings = new Map<number, PiCallBinding>();
  let owners = ["123"];
  const mcp = await PiMcp.attach({ registry, harness, storage, config, secrets: { readReferencedVariable: () => undefined }, owners: () => owners,
    binding: async id => bindings.get(id) });
  let closed = false;
  const close = async () => { if (closed) return; closed = true; mcp.beginShutdown(); await harness.close(context); await mcp.close(); };
  cleanup.push(close);
  const create = async (binding = owner()) => {
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: faux.getModel().provider, modelId: "test" } } }, context);
    bindings.set(Number(conv.id), binding); return conv;
  };
  const configure = (conversation: Conversation, ctx = context) => mcp.configure({ conversation, turn: bindings.get(Number(conversation.id))! }, ctx);
  // 业务工具只给脚本调用，经 nested 嵌套调用。
  const run = async (conv: Conversation, name: string, args: JsonObject = { value: 1 }, direct = false) => {
    const business = !direct && name.startsWith("mcp_") && !isMcpControlTool(name);
    selected = business ? "nested" : name; argumentsValue = business ? { name, args } : args;
    return (await conv.submit({ type: "input", content: "执行一次" }, context)).wait(context);
  };
  return { mcp, harness, registry, db, bindings, create, configure, run, close, requests, revoke: () => { owners = []; } };
}
const names = async (conv: Conversation) => { const agent = await conv.agent(context); return [...new Set([...agent.tools, ...agent.callable].map(t => t.name))].filter(n => n !== "nested"); };
const mcpNames = async (conv: Conversation) => (await names(conv)).filter(n => n.startsWith("mcp_") && !isMcpControlTool(n));
const results = async (conv: Conversation) => (await conv.entries({ order: "ascending" }, 1000, undefined, context)).items.filter(ToolResultEntry.is);

describe("Pi MCP 原生工具与持久目录", () => {
  it("保留原扩展、精确 allowlist、unsafe 原生调用与结构化结果", async () => {
    const s = await server(), r = await rig(s.config()), c = await r.create();
    await r.configure(c);
    expect(await names(c)).toEqual(["local", "codemode", "mcp_refresh_tools", expect.stringMatching(/^mcp_fixture_lookup_\w+$/)]);
    expect((await c.agent(context)).tools.map(t => t.name)).toEqual(["local", "nested", "codemode", "mcp_refresh_tools"]);
    const [name] = await mcpNames(c);
    expect(r.registry.snapshot().tools().find(t => t.tool.name === name)!.tool.replay).toBe("unsafe");
    expect(await r.run(c, name!)).toMatchObject({ status: "done" });
    const codemode = JSON.parse(r.requests.at(-1)!).find((m: { sections?: Record<string, string> }) => m.sections?.codemode)?.sections?.codemode;
    expect(codemode).toContain(`## fixture\n\n### \`${name}\``);
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
    expect((await c.agent(context)).callable.find(tool => tool.name === lookup)?.description).toContain("更新后的描述");
    expect(r.registry.snapshot().tools().filter(item => item.tool.name === lookup)).toHaveLength(1);
    expect(r.requests.some(request => request.includes("更新后的描述"))).toBe(true);
    const revisions = Object.values((await r.harness.snapshot(McpCatalogsDoc, context))!.revisions);
    expect(r.mcp.toolIdentity(lookup)?.catalogDigest).toBe(revisions.at(-1)?.digest);
  });

  it("刷新后调用历史旧名称得到 tool_unavailable，远端未执行", async () => {
    const s = await server(), r = await rig(s.config()), c = await r.create();
    await r.configure(c); const [old] = await mcpNames(c);
    s.state.version++;
    await r.mcp.configure({ conversation: c, turn: owner(), refresh: true }, context);
    expect(await mcpNames(c)).not.toContain(old);
    await r.run(c, old!);
    expect(s.state.calls).toBe(0);
    expect((await results(c))[0]?.data?.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "tool_unavailable" })]));
  });

  it("另一会话的工具名与撤权后的旧名称都不发送", async () => {
    const s = await server(), r = await rig(s.config()), a = await r.create(), b = await r.create();
    await r.configure(a); await r.configure(b);
    const [foreign] = await mcpNames(a);
    await r.run(b, foreign!);
    s.state.version++;
    await r.mcp.configure({ conversation: a, turn: owner(), refresh: true }, context);
    r.revoke(); await r.run(a, foreign!);
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

  it("存储的 v1 目录被拒绝并原样保留，不影响 v2 目录恢复与调用", async () => {
    const s = await server(), first = await rig(s.config()), c = await first.create();
    await first.configure(c); const [name] = await mcpNames(c), id = c.id;
    const valid = Object.values((await first.harness.snapshot(McpCatalogsDoc, context))!.revisions)[0]!;
    const { digest: _ignored, ...payload } = valid;
    const legacy = { ...payload, adapterVersion: 1 }, legacyDigest = digest(legacy);
    await first.harness.commit(async tx => {
      (await tx.doc(McpCatalogsDoc)).revisions = { [legacyDigest]: { ...legacy, digest: legacyDigest } as never, [valid.digest]: valid };
    }, context);
    await first.close();
    const rejected: unknown[] = [];
    const untap = trace.tap(event => { if (event.detail.code === "catalog_restore_rejected") rejected.push(event); });
    cleanup.push(async () => untap());
    const second = await rig(s.config(), first.db), restored = (await second.harness.conversation(id, context))!;
    second.bindings.set(Number(id), owner());
    expect(rejected).toHaveLength(1);
    expect(Object.keys((await second.harness.snapshot(McpCatalogsDoc, context))!.revisions).sort()).toEqual([legacyDigest, valid.digest].sort());
    expect(await mcpNames(restored)).toEqual([name]);
    expect(await second.run(restored, name!)).toMatchObject({ status: "done" });
    expect(s.state.calls).toBe(1);
  });

  it("超时报告 outcome_unknown，不重发业务请求", async () => {
    const s = await server(), r = await rig(s.config({ callMs: 300 })), c = await r.create();
    await r.configure(c); const [name] = await mcpNames(c); s.state.hang = true;
    await r.run(c, name!); expect(s.state.calls).toBe(1);
    expect((await results(c))[0]?.data?.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "mcp_outcome_unknown" })]));
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

  it("重启后历史 tool_unavailable 不再报告终态，本进程新结果只报告一次", async () => {
    const s = await server(), first = await rig(s.config()), c = await first.create();
    await first.configure(c); const [old] = await mcpNames(c), id = c.id;
    s.state.version++;
    await first.mcp.configure({ conversation: c, turn: owner(), refresh: true }, context);
    await first.run(c, old!, undefined, true);
    await first.close();
    const terminals: Record<string, unknown>[] = [];
    const untap = trace.tap(event => { if (event.stage === "mcp_recovered_terminal") terminals.push(event.detail); });
    cleanup.push(async () => untap());
    const second = await rig(s.config(), first.db), restored = (await second.harness.conversation(id, context))!;
    second.bindings.set(Number(id), owner());
    const stream = await watchEvents(second.harness, id, context);
    cleanup.push(() => stream.stop());
    expect(stream.snapshot.entries.filter(ToolResultEntry.is)).toHaveLength(1);
    second.mcp.observeEvent(Number(id), stream.snapshot);
    stream.start(async events => { for (const event of events) second.mcp.observeEvent(Number(id), event); });
    await second.run(restored, old!, undefined, true);
    const [historical, fresh] = await results(restored);
    for (const entry of [historical, fresh]) {
      expect(entry?.data?.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "tool_unavailable" })]));
    }
    await vi.waitFor(() => expect(terminals).toHaveLength(1));
    second.mcp.observeEvent(Number(id), { type: "entry_appended", entry: fresh! });
    expect(terminals).toEqual([expect.objectContaining({ entryId: fresh!.id, code: "tool_unavailable" })]);
    expect(s.state.calls).toBe(0);
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

describe("Pi MCP 目录保留", () => {
  const agentWrites = (r: Awaited<ReturnType<typeof rig>>, id: Conversation["id"]) => {
    const seen: number[] = [];
    cleanup.push(async () => stop());
    const stop = r.harness.subscribeCommits(publication => {
      if (publication.changes.some(change => change.type === "document" && change.record.kind === "pi.agent" && change.conversationId === id)) seen.push(publication.seq);
    });
    return seen;
  };

  it("禁用配置或选择不变时不写 AgentDoc", async () => {
    const s = await server(), enabled = await rig(s.config()), c = await enabled.create();
    await enabled.configure(c);
    const writes = agentWrites(enabled, c.id);
    await enabled.configure(c);
    expect(writes).toEqual([]);
    s.state.version++; await enabled.mcp.configure({ conversation: c, turn: owner(), refresh: true }, context);
    expect(writes).toHaveLength(1);
    const disabled = await rig({ kind: "disabled", reason: "停用" }), d = await disabled.create();
    await disabled.configure(d);
    const idle = agentWrites(disabled, d.id);
    await disabled.configure(d); await disabled.configure(d);
    expect(idle).toEqual([]);
  });

  const stored = async (r: Awaited<ReturnType<typeof rig>>) => Object.keys((await r.harness.snapshot(McpCatalogsDoc, context))!.revisions).sort();
  const refresh = (r: Awaited<ReturnType<typeof rig>>, conversation: Conversation) =>
    r.mcp.configure({ conversation, turn: r.bindings.get(Number(conversation.id))!, refresh: true }, context);
  const strip = (r: Awaited<ReturnType<typeof rig>>, ...ids: Conversation["id"][]) => r.harness.commit(async tx => {
    for (const id of ids) (await tx.doc(AgentDoc, id)).extensions = ["base"];
  }, context);

  it("远端目录反复变化回收旧版本，不再撞上存储上限", async () => {
    const s = await server(), r = await rig(s.config({ retainedRevisions: 2 })), c = await r.create();
    await r.configure(c);
    for (let i = 0; i < 5; i++) { s.state.version++; await refresh(r, c); }
    const [name] = await mcpNames(c);
    expect(name).toBeDefined();
    expect(await stored(r)).toHaveLength(2);
    expect(await r.run(c, name!, { value: 6 })).toMatchObject({ status: "done" });
    expect(s.state.calls).toBe(1);
  });

  it("重启回收：别的会话仍选择的版本保留，无人引用的删除", async () => {
    const s = await server(), first = await rig(s.config()), a = await first.create(), b = await first.create();
    await first.configure(a); await first.configure(b);
    const [old] = await mcpNames(a), [kept] = await mcpNames(b);
    s.state.version++; await refresh(first, a);
    const [current] = await mcpNames(a);
    expect(await stored(first)).toHaveLength(3);
    await first.close();
    const second = await rig(s.config(), first.db);
    const restored = { a: (await second.harness.conversation(a.id, context))!, b: (await second.harness.conversation(b.id, context))! };
    expect(await stored(second)).toEqual([second.mcp.toolIdentity(current!)!.catalogDigest, second.mcp.toolIdentity(kept!)!.catalogDigest].sort());
    expect(second.mcp.toolIdentity(old!)).toBeUndefined();
    expect(await mcpNames(restored.b)).toEqual([kept]);
    second.bindings.set(Number(a.id), owner());
    expect(await second.run(restored.a, current!, { value: 2 })).toMatchObject({ status: "done" });
    expect(s.state.calls).toBe(1);
  });

  it("只改描述的目录在重启后收敛为每个契约一个版本", async () => {
    const s = await server(), first = await rig(s.config()), c = await first.create();
    await first.configure(c); const [name] = await mcpNames(c);
    for (const text of ["一", "二", "三"]) { s.state.description = text; await refresh(first, c); }
    expect(await mcpNames(c)).toEqual([name]);
    expect(await stored(first)).toHaveLength(4);
    await first.close();
    const second = await rig(s.config(), first.db), restored = (await second.harness.conversation(c.id, context))!;
    second.bindings.set(Number(c.id), owner());
    expect(await stored(second)).toHaveLength(1);
    expect(await mcpNames(restored)).toEqual([name]);
    expect(await second.run(restored, name!)).toMatchObject({ status: "done" });
    expect(s.state.calls).toBe(1);
  });

  const interrupted = async (dropLiveRevision: boolean) => {
    const s = await server(), first = await rig(s.config()), a = await first.create(), b = await first.create();
    await first.configure(a); await first.configure(b);
    const [live] = await mcpNames(a), [idle] = await mcpNames(b);
    const liveDigest = first.mcp.toolIdentity(live!)!.catalogDigest, idleDigest = first.mcp.toolIdentity(idle!)!.catalogDigest;
    s.state.hang = true;
    const running = first.run(a, live!).catch(() => undefined);
    await vi.waitFor(() => expect(s.state.calls).toBe(1));
    await strip(first, a.id, b.id);
    if (dropLiveRevision) await first.harness.commit(async tx => { delete (await tx.doc(McpCatalogsDoc)).revisions[liveDigest]; }, context);
    await first.close(); await running;
    const second = await rig(s.config(), first.db);
    return { stored: await stored(second), liveDigest, idleDigest };
  };

  it("活工具任务引用的旧版本在回收中保留", async () => {
    const { stored, liveDigest } = await interrupted(false);
    expect(stored).toEqual([liveDigest]);
  });

  it("活工具任务的名字找不到版本时整轮不删", async () => {
    const { stored, idleDigest } = await interrupted(true);
    expect(stored).toEqual([idleDigest]);
  });
});

async function delegated(r: Awaited<ReturnType<typeof rig>>, parent: Conversation) {
  const bound = r.bindings.get(Number(parent.id))!;
  const inherited = runRights(bound, ["123"]).person;
  const child = await r.create({ ...bound, child: true, identity: { kind: "wake", ...(inherited ? { inherited } : {}) } });
  const grant = await r.mcp.delegation(parent.id);
  await r.harness.commit(async tx => { (await tx.doc(McpDelegationDoc, child.id)).grant = grant; }, context);
  await r.configure(child);
  return child;
}

const resourceText = async (conv: Conversation) => (await results(conv)).at(-1)?.model?.flatMap(message => message.role === "toolResult"
  ? message.content.flatMap(item => item.type === "text" ? [item.text] : []) : []).join("\n") ?? "";
const resourceDiagnostic = async (conv: Conversation, code: string) => expect((await results(conv)).at(-1)?.data?.diagnostics)
  .toEqual(expect.arrayContaining([expect.objectContaining({ code })]));

describe("Pi MCP 只读资源", () => {
  it("前缀为空不选择资源工具；开放后紧跟刷新工具，采用 safe 串行执行", async () => {
    const s = await server(), off = await rig(s.config()), a = await off.create();
    await off.configure(a);
    expect(await names(a)).not.toContain("mcp_list_resources");
    expect(await names(a)).not.toContain("mcp_read_resource");
    const on = await rig(s.config({}, {}, [], ["notion://docs/"])), b = await on.create();
    await on.configure(b);
    expect(await names(b)).toEqual(["local", "codemode", "mcp_refresh_tools", "mcp_list_resources", "mcp_read_resource"]);
    for (const name of ["mcp_list_resources", "mcp_read_resource"]) {
      expect(on.registry.snapshot().tools().find(item => item.tool.name === name)?.tool)
        .toMatchObject({ replay: "safe", executionMode: "sequential", outputLimits: { maxBytes: 32_768 } });
    }
  });

  it("资源和模板完整分页再过滤，清洗远端描述并输出服务 id", async () => {
    const s = await server(), r = await rig(s.config({}, {}, [], ["notion://docs/"])), c = await r.create();
    await r.configure(c); await r.run(c, "mcp_list_resources", {});
    const text = await resourceText(c);
    expect(text).toContain("[服务 fixture] 资源 2 项，模板 1 项");
    expect(text).toContain("notion://docs/memory | Memory Title");
    expect(text).toContain("notion://docs/skills"); expect(text).toContain("notion://docs/{id}");
    expect(text).not.toContain("ui://"); expect(text).not.toContain("\u0000"); expect(text).not.toContain("长".repeat(300));
    expect(s.state.resourceLists).toBe(2); expect(s.state.templateLists).toBe(2);
  });

  it("text 带来源头，远端 JSON-RPC 错误保留清洗后的短消息", async () => {
    const s = await server(), r = await rig(s.config({}, {}, ["lookup"], ["notion://docs/"])), c = await r.create();
    await r.configure(c); await r.run(c, "mcp_read_resource", { server: "fixture", uri: "notion://docs/memory" });
    expect(await resourceText(c)).toContain("[MCP 资料来源：notion://docs/memory；text/markdown]\nRESOURCE_BODY_SENTINEL");
    const sessions = s.state.sessions;
    await r.run(c, "mcp_read_resource", { server: "fixture", uri: "notion://docs/missing" });
    await resourceDiagnostic(c, "mcp_remote_error");
    expect(await resourceText(c)).toContain("远端拒绝或找不到资源（code -32002）：RESOURCE_ERROR_SENTINEL 找不到资源");
    await r.run(c, (await mcpNames(c))[0]!);
    expect(s.state.calls).toBe(1);
    expect(s.state.sessions).toBe(sessions); expect(s.state.deletes).toBe(0);
  });

  it("不匹配前缀、大小写不同和非法 URI 均在联网前拒绝", async () => {
    const s = await server(), r = await rig(s.config({}, {}, [], ["notion://docs/"])), c = await r.create();
    await r.configure(c); const sessions = s.state.sessions;
    for (const uri of ["notion://private/memory", "Notion://docs/memory"]) {
      await r.run(c, "mcp_read_resource", { server: "fixture", uri });
      await resourceDiagnostic(c, "mcp_resource_not_allowed");
    }
    for (const uri of ["relative/path", "notion://docs/\nsecret"]) {
      await r.run(c, "mcp_read_resource", { server: "fixture", uri });
      await resourceDiagnostic(c, "mcp_invalid_arguments");
    }
    expect(s.state.resourceReads).toBe(0); expect(s.state.sessions).toBe(sessions);
    await r.run(c, "mcp_list_resources", { server: "unknown" }); await resourceDiagnostic(c, "mcp_denied");
  });

  it("缺少 resources capability 不发送任何资源请求", async () => {
    const s = await server(); s.state.resources = false;
    const r = await rig(s.config({}, {}, [], ["notion://docs/"])), c = await r.create();
    await r.configure(c); await r.run(c, "mcp_list_resources", { server: "fixture" });
    await resourceDiagnostic(c, "mcp_resources_unsupported");
    await r.run(c, "mcp_read_resource", { server: "fixture", uri: "notion://docs/memory" });
    await resourceDiagnostic(c, "mcp_resources_unsupported");
    expect(s.state.resourceReads + s.state.resourceLists + s.state.templateLists).toBe(0);
  });

  it("单服务失败保留其他服务结果；全部失败才标为错误", async () => {
    const a = await server(), b = await server(); b.state.resources = false;
    const config = a.config({}, {}, [], ["notion://docs/"]), other = b.config({}, {}, [], ["notion://docs/"]);
    if (config.kind !== "enabled" || other.kind !== "enabled") throw new Error("fixture_config");
    config.value.servers.push({ ...other.value.servers[0], id: "unsupported" });
    const r = await rig(config), c = await r.create();
    await r.configure(c); await r.run(c, "mcp_list_resources", {});
    expect((await results(c)).at(-1)?.model?.[0]).toMatchObject({ isError: false });
    expect(await resourceText(c)).toContain("[服务 fixture] 资源 2 项");
    expect(await resourceText(c)).toContain("[服务 unsupported] resources_unsupported");
    await r.run(c, "mcp_list_resources", { server: "unsupported" });
    expect((await results(c)).at(-1)?.model?.[0]).toMatchObject({ isError: true });
  });

  it("撤销 owner 后拒绝已选中的资源工具，远端零请求", async () => {
    const s = await server(), r = await rig(s.config({}, {}, [], ["notion://docs/"])), c = await r.create();
    await r.configure(c); r.revoke();
    await r.run(c, "mcp_read_resource", { server: "fixture", uri: "notion://docs/memory" });
    await resourceDiagnostic(c, "mcp_denied"); expect(s.state.resourceReads).toBe(0);
  });

  it.each(["queue", "connect"] as const)("资源调用在 %s 等待期间撤权，恢复后仍拒绝", async phase => {
    const s = await server(), r = await rig(s.config({ idleMs: phase === "connect" ? 5 : 300_000 }, {}, [], ["notion://docs/"])), c = await r.create();
    await r.configure(c);
    if (phase === "connect") await vi.waitFor(() => expect(s.state.deletes).toBe(1));
    const release = s.hold(phase === "queue" ? "tools/list" : "initialize");
    const refresh = phase === "queue" ? r.mcp.configure({ conversation: c, turn: owner(), refresh: true }, context) : Promise.resolve();
    if (phase === "queue") await vi.waitFor(() => expect(s.state.lists).toBe(2));
    const bound = vi.spyOn(r.bindings, "get");
    const running = r.run(c, "mcp_read_resource", { server: "fixture", uri: "notion://docs/memory" });
    try {
      await vi.waitFor(() => phase === "connect" ? expect(s.state.sessions).toBe(2) : expect(bound).toHaveBeenCalled());
      expect(s.state.resourceReads).toBe(0);
      r.revoke();
    } finally { release(); }
    await Promise.all([refresh, running]);
    await resourceDiagnostic(c, "mcp_denied"); expect(s.state.resourceReads).toBe(0);
  });

  it("超大文本与列表受总文本预算约束；PNG 转成图片，其他 blob 明确省略", async () => {
    const s = await server(), config = s.config({ textBytes: 256 }, {}, [], ["notion://docs/"]);
    if (config.kind !== "enabled") throw new Error("fixture_config");
    config.value.servers.push(...["second", "third"].map(id => ({ ...config.value.servers[0], id })));
    const complete = await rig({ ...config, value: { ...config.value, limits: { ...config.value.limits, textBytes: 32_768 } } });
    const full = await complete.create();
    await complete.configure(full); await complete.run(full, "mcp_list_resources", {});
    const original = await resourceText(full);
    expect(original).not.toContain("MCP 文本已截断");
    const r = await rig(config), c = await r.create();
    await r.configure(c);
    await r.run(c, "mcp_list_resources", {});
    expect((await resourceText(c)).match(/\[MCP 文本已截断；原始 \d+ 字节\]/gu))
      .toEqual([`[MCP 文本已截断；原始 ${Buffer.byteLength(original, "utf8")} 字节]`]);
    expect((await results(c)).at(-1)?.data?.diagnostics.filter(item => item.code === "text_truncated")).toHaveLength(1);
    for (const suffix of ["large", "png", "binary", "empty"]) {
      await r.run(c, "mcp_read_resource", { server: "fixture", uri: `notion://docs/${suffix}` });
      const text = await resourceText(c);
      // Pi 会另加 <harness> 诊断文本；预算限制的是转换函数交付的正文块。
      const message = (await results(c)).at(-1)?.model?.[0];
      if (message?.role === "toolResult" && message.content[0]?.type === "text") {
        expect(Buffer.byteLength(message.content[0].text)).toBeLessThanOrEqual(256);
      }
      if (suffix === "large") { expect(text).toContain("MCP 文本已截断；原始"); expect(text).not.toContain("�"); }
      if (suffix === "png") expect((await results(c)).at(-1)?.model?.[0]).toMatchObject({ content: [expect.objectContaining({ type: "image", mimeType: "image/png" })] });
      if (suffix === "binary") { expect(text).toContain("二进制资源 application/octet-stream，base64 4 字节，未解码"); await resourceDiagnostic(c, "content_omitted"); }
      if (suffix === "empty") expect(text).toBe("[MCP 资源为空]");
    }
  });

  it("资源超时为 timeout，关闭连接且不使用 outcome_unknown", async () => {
    const s = await server(), r = await rig(s.config({ callMs: 300 }, {}, [], ["notion://docs/"])), c = await r.create();
    await r.configure(c); s.state.resourceHang = true;
    await r.run(c, "mcp_read_resource", { server: "fixture", uri: "notion://docs/memory" });
    await resourceDiagnostic(c, "mcp_timeout"); expect(await resourceText(c)).not.toContain("outcome_unknown");
    expect(s.state.resourceReads).toBe(1); expect(s.state.deletes).toBeGreaterThan(0);
  });

  it("群成员及获委派的子 agent 可只读访问，子白名单包含两个入口", async () => {
    const s = await server(), r = await rig(s.config({}, { groups: ["7"], allowSubagent: true }, [], ["notion://docs/"]));
    const parent = await r.create({ ...owner(), threadKey: "group:7", scope: "group:7", identity: { kind: "user", sender: "456" } });
    await r.configure(parent);
    const grant = await r.mcp.delegation(parent.id);
    for (const name of ["mcp_refresh_tools", "mcp_list_resources", "mcp_read_resource"]) {
      expect(r.mcp.allowsDelegationTool(grant, name)).toBe(true);
      expect(r.mcp.allowsDelegationTool(null, name)).toBe(false);
      expect(r.mcp.allowsDelegationTool({ principal: "456", servers: {}, wake: false, scheduled: false }, name)).toBe(false);
    }
    await r.run(parent, "mcp_read_resource", { server: "fixture", uri: "notion://docs/memory" });
    const child = await delegated(r, parent);
    await r.harness.commit(async tx => { const doc = await tx.doc(AgentDoc, child.id); doc.tools = ["local"]; doc.modelTools = ["local"]; }, context);
    await r.configure(child);
    expect(await names(child)).toEqual(["local", "codemode", "mcp_refresh_tools", "mcp_list_resources", "mcp_read_resource"]);
    await r.run(child, "mcp_read_resource", { server: "fixture", uri: "notion://docs/memory" });
    expect((await results(child)).at(-1)?.model?.[0]).toMatchObject({ isError: false });
    expect(s.state.resourceReads).toBe(2); expect(s.state.sessions).toBe(2);
  });
});

describe("Pi MCP 委派授权交集", () => {
  it.each([
    { identity: { kind: "user", sender: "123" }, access: {}, allowed: true },
    { identity: { kind: "scheduled", creator: "123" }, access: {}, allowed: false },
    { identity: { kind: "scheduled", creator: "123" }, access: { allowScheduled: true }, allowed: true },
    { identity: { kind: "wake" }, access: { allowWake: true }, allowed: false },
    { identity: { kind: "wake", inherited: { kind: "user", person: "123", owner: true } }, access: {}, allowed: false },
    { identity: { kind: "wake", inherited: { kind: "user", person: "123", owner: true } }, access: { allowWake: true }, allowed: true },
    { identity: { kind: "wake", inherited: { kind: "scheduled", person: "123", owner: true } }, access: { allowWake: true }, allowed: false },
    { identity: { kind: "wake", inherited: { kind: "scheduled", person: "123", owner: true } }, access: { allowWake: true, allowScheduled: true }, allowed: true },
  ] satisfies { identity: PiCallBinding["identity"]; access: object; allowed: boolean }[])("按派出回合检查 scheduled/wake：%j", async ({ identity, access, allowed }) => {
    const s = await server(), r = await rig(s.config({}, { allowSubagent: true, ...access }));
    const parent = await r.create({ ...owner(), identity }), child = await delegated(r, parent);
    expect(await mcpNames(child)).toHaveLength(allowed ? 1 : 0);
    const grant = (await r.harness.snapshot(McpDelegationDoc, child.id, context))?.grant;
    if (allowed) {
      expect(grant?.principal).toBe("123");
      await r.run(child, (await mcpNames(child))[0]!);
      expect((await results(child))[0]?.model?.[0]).toMatchObject({ role: "toolResult", isError: false });
      expect(s.state.calls).toBe(1);
    } else { expect(grant).toBeNull(); expect(s.state.sessions).toBe(0); }
  });

  it.each(["missing", "principal", "scope", "allowSubagent"] as const)("工具已选中但 %s 失效，执行与刷新均拒绝", async revoke => {
    const s = await server(), config = s.config({}, { allowSubagent: true }), r = await rig(config);
    const parent = await r.create(), child = await delegated(r, parent), name = (await mcpNames(child))[0]!;
    const selection = await r.harness.snapshot(AgentDoc, child.id, context);
    if (config.kind !== "enabled") throw new Error("config");
    if (revoke === "missing") await r.harness.commit(async tx => { (await tx.doc(McpDelegationDoc, child.id)).grant = null; }, context);
    else if (revoke === "principal") r.revoke();
    else if (revoke === "scope") r.bindings.set(Number(child.id), { ...owner(), child: true, scope: "group:123", threadKey: "group:123" });
    else config.value.servers[0]!.access.allowSubagent = false;
    await r.run(child, name);
    expect((await results(child))[0]?.data?.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "mcp_denied" })]));
    await r.harness.commit(async tx => { Object.assign(await tx.doc(AgentDoc, child.id), selection); }, context);
    await r.run(child, "mcp_refresh_tools", {});
    expect((await results(child))[1]?.data?.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "mcp_denied" })]));
    expect(s.state.calls).toBe(0); expect(s.state.lists).toBe(1);
  });

  it.each(["replace", "remove"] as const)("读取调用身份期间配置 %s 撤服，不能沿用旧服务引用", async change => {
    const s = await server(), config = s.config({}, { allowSubagent: true }), r = await rig(config);
    const parent = await r.create(), child = await delegated(r, parent), name = (await mcpNames(child))[0]!;
    if (config.kind !== "enabled") throw new Error("config");
    const lookup = r.bindings.get.bind(r.bindings);
    vi.spyOn(r.bindings, "get").mockImplementation(id => {
      config.value.servers = change === "remove" ? [] : config.value.servers.map(server => ({ ...server, enabled: false }));
      return lookup(id);
    });
    await r.run(child, name);
    expect((await results(child))[0]?.data?.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "mcp_denied" })]));
    expect(s.state.calls).toBe(0);
  });
});

it("事件切换后旧目录写工具被执行复核拒绝，事件目录与用户目录隔离", async () => {
  const s = await server(), config = s.config({}, {}, ["lookup", "other"]);
  if (config.kind !== "enabled") throw new Error("config");
  config.value.servers[0].tools.eventAllow = ["lookup"];
  const r = await rig(config), c = await r.create();
  await r.configure(c);
  const oldNames = await mcpNames(c), write = oldNames.find(name => name.includes("_other_"))!;
  r.bindings.set(Number(c.id), { ...owner(), auth: false, identity: { kind: "event", source: "gmail", creator: "123" } });
  await r.run(c, write);
  expect(s.state.calls).toBe(0);
  expect((await results(c))[0]?.data?.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "mcp_denied" })]));
  await r.configure(c);
  const eventNames = await mcpNames(c);
  expect(eventNames).toEqual([expect.stringMatching(/^mcp_fixture_lookup_/)]);
  expect(eventNames[0]).not.toBe(oldNames.find(name => name.includes("_lookup_")));
  await r.run(c, eventNames[0]); expect(s.state.calls).toBe(1);
});

import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createRegistry } from "@earendil-works/pi-durable";
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { ThreadMcp, type McpAuthority } from "../src/mcp";
import { MCP_CATALOG_SCHEMA } from "../src/mcp/catalog";
import worker from "../src/index";
import { McpConnection } from "../src/mcp/connection";
import { MCP_CONFIG } from "../src/mcp/config";
import { manageMcp } from "../src/mcp/manage";

afterEach(reset);
const id = "fixture-node", bearer = "Bearer " + "a".repeat(43);
const upgrade = (auth = "", suffix = "") => worker.fetch(new Request(env.PUBLIC_ORIGIN + "/mcp/reverse/" + id + suffix,
  { headers: { Upgrade: "websocket", ...(auth ? { Authorization: auth } : {}) } }), env);
const limits = { ...MCP_CONFIG.limits, connectMs: 2000, callMs: 2000 };
async function node(label: string, beforeReply?: (s: WebSocket) => void) {
  const socket = (await upgrade(bearer)).webSocket!;
  const sessions = new Map<string, Transport>();
  async function receive(e: MessageEvent) {
    const frame = JSON.parse(String(e.data)) as { session: string; message: JSONRPCMessage; close?: true };
    let transport = sessions.get(frame.session);
    if (frame.close) { await transport?.close(); sessions.delete(frame.session); return; }
    if (!transport) {
      const sdk = new Server({ name: label, version: "1" }, { capabilities: { tools: {} } });
      sdk.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: "hello", inputSchema: { type: "object" } }] }));
      sdk.setRequestHandler(CallToolRequestSchema, () => { beforeReply?.(socket); return { content: [{ type: "text", text: label }] }; });
      transport = { async start() {}, async send(message) { socket.send(JSON.stringify({ session: frame.session, message })); },
        async close() { this.onclose?.(); } };
      sessions.set(frame.session, transport);
      await sdk.connect(transport);
    }
    transport.onmessage?.(frame.message);
  }
  socket.addEventListener("message", e => { void receive(e); });
  socket.accept();
  return socket;
}

it("authenticates registration, probes a real SDK server and isolates replaced/disconnected sessions", async () => {
  const registry = env.REGISTRY.getByName("main");
  let record = await registry.mcpServerPut({ id, transport: "reverse-websocket" }, "absent");
  expect((await upgrade(bearer)).status).toBe(401);
  record = await registry.mcpCredentialPut(id, record.revision, { Authorization: bearer });
  expect((await upgrade()).status).toBe(401);
  expect((await upgrade("Bearer " + "b".repeat(43))).status).toBe(401);
  expect((await upgrade("", "?access_token=fixture")).status).toBe(401);
  const probe = () => manageMcp(env, { action: "probe", id, expectedRevision: record.revision });
  expect(await probe()).toMatchObject({ status: "unavailable", code: "reverse_offline" });
  const original = await node("one");
  expect(await probe()).toMatchObject({ status: "ready", discovered: [{ name: "hello" }] });
  record = await registry.mcpServerGet(id);
  const open = () => McpConnection.open(record.server, env, limits, AbortSignal.timeout(3000), () => {});
  const call = (c: McpConnection) => c.callTool("hello", {}, { scope: "owner" }, AbortSignal.timeout(3000));
  const a = await open();
  expect((await call(a)).content).toEqual([{ type: "text", text: "one" }]);
  const replacement = await node("two");
  await expect(call(a)).rejects.toThrow();
  const b = await open();
  expect((await call(b)).content).toEqual([{ type: "text", text: "two" }]);
  replacement.close(1000);
  await expect(call(b)).rejects.toThrow();
  expect(await probe()).toMatchObject({ status: "unavailable", code: "reverse_offline" });
  const reconnected = await node("three"), c = await open();
  expect((await call(c)).content).toEqual([{ type: "text", text: "three" }]);
  await Promise.all([a.close(), b.close(), c.close()]);
  reconnected.close(1000); original.close(1000);
});

it("requires the normal approval and preserves unknown outcome when an approved write loses its reply", async () => {
  const registry = env.REGISTRY.getByName("main");
  let record = await registry.mcpServerPut({ id, transport: "reverse-websocket" }, "absent");
  record = await registry.mcpCredentialPut(id, record.revision, { Authorization: bearer });
  const scope = "group:200000001", actor: McpAuthority = { kind: "agent", scope, actor: "agent:" + scope, owner: false, generation: 2, replyChannel: "qq" };
  const owner: McpAuthority = { kind: "message", scope: "owner", actor: "admin:web", owner: true, generation: 1, replyChannel: "web" };
  await runInDurableObject(env.THREAD.getByName(scope), async (_instance, state) => {
    const registry = env.REGISTRY.getByName("main");
    let calls = 0;
    await node("first", socket => { calls++; socket.close(1000); });
    expect(await manageMcp(env, { action: "probe", id, expectedRevision: record.revision })).toMatchObject({ status: "ready" });
    const activated = await registry.mcpServerActivate(id, (await registry.mcpServerGet(id)).revision, { allow: ["hello"] });
    if ("error" in activated) throw new Error("activation_failed");
    const db = new DurableObjectSqliteDatabase(state.storage);
    await db.exec(MCP_CATALOG_SCHEMA + "CREATE TABLE IF NOT EXISTS events(at INTEGER,kind TEXT,detail TEXT)");
    const mcp = new ThreadMcp(db, env, createRegistry(), async () => actor, { ...MCP_CONFIG, servers: [activated.server], limits }, { scope });
    try {
      await mcp.restore();
      await mcp.setAccess(scope, id, { tools: ["hello"], actors: [actor.actor], resourceAllow: [], expiresAt: null }, "none", owner);
      await mcp.refreshAll();
      const snapshot = await mcp.captureCapabilities(actor), call = { name: snapshot.tools[0]!, args: {}, operationId: "one-write", snapshot };
      expect(JSON.stringify(await mcp.invoke(call, async () => actor))).toContain("pending");
      expect(calls).toBe(0);
      const approval = (await mcp.policy.list(scope))[0]!;
      expect(JSON.stringify(await mcp.reviewApproval(scope, approval.id, "approve", owner, async () => actor))).toContain("outcome_unknown");
      const replacement = await node("replacement", () => { calls++; });
      expect(JSON.stringify(await mcp.invoke(call, async () => actor))).toContain("outcome_unknown");
      expect(calls).toBe(1);
      replacement.close(1000);
    } finally { await mcp.close(); }
  });
});

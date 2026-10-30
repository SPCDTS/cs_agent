import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRegistry } from "@earendil-works/pi-durable";
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { ThreadMcp, type McpAuthority } from "../src/mcp";
import { McpPolicyStore } from "../src/mcp/policy";
import { MCP_CONFIG } from "../src/mcp/config";
import { makeCatalog, MCP_CATALOG_SCHEMA } from "../src/mcp/catalog";
import { toolNames } from "../src/mcp/names";
import { fakeRemote, login } from "./mcp-helpers";

afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const group = "group:200000001";
const actor: McpAuthority = { kind: "message", scope: group, actor: "10000003", owner: false, generation: 2, replyChannel: "web" };
const reviewer: McpAuthority = { kind: "message", scope: "owner", actor: "10000001", owner: true, generation: 1, replyChannel: "web" };
describe("scoped MCP exact-call approval", () => {
  it("keeps groups closed by default and executes each approved write once while rejecting later requests", async () => {
    const remote = fakeRemote(); await login();
    remote.state.tools = [{ name: "notion-create-pages", description: "创建页面",
      inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false } }];
    await env.THREAD.getByName(group).stats();
    await runInDurableObject(env.THREAD.getByName(group), async (_instance, state) => {
      const db = new DurableObjectSqliteDatabase(state.storage); await db.exec(MCP_CATALOG_SCHEMA);
      const registry = createRegistry(), mcp = new ThreadMcp(db, env, registry, async () => actor, MCP_CONFIG, { scope: group });
      await mcp.restore(); await mcp.refreshAll();
      const catalog = makeCatalog(MCP_CONFIG.servers[0]!, remote.state.tools, MCP_CONFIG.limits).revision;
      const name = toolNames(catalog, catalog.tools[0]!).nativeName;
      const call = { name, args: { title: "已审阅的合成标题" }, operationId: "write-one" };
      expect((await mcp.invoke(call, async () => actor)).isError).toBe(true);
      expect(registry.snapshot().tools().some(t => t.tool.name === name)).toBe(false);
      const grant = await mcp.setAccess(group, "notion", { tools: ["notion-create-pages"], resourceAllow: [], actors: [actor.actor], expiresAt: null }, "none", reviewer);
      expect(grant.tools).toEqual(["notion-create-pages"]);
      await mcp.refreshAll();
      expect(registry.snapshot().tools().some(t => t.tool.name === name)).toBe(true);
      expect(JSON.stringify((await mcp.invoke(call, async () => actor)).output)).toContain("pending");
      expect(remote.state.calls).toBe(0);
      const pending = (await mcp.policy.list(group))[0]!;
      expect(pending).toMatchObject({ actor: actor.actor, generation: 2, reply_channel: "web", status: "pending" });
      expect(JSON.parse(pending.args_json)).toEqual(call.args);
      expect(await mcp.reviewApproval(group, pending.id, "approve", reviewer, async () => actor)).toMatchObject({ status: "reviewed" });
      expect(remote.state.calls).toBe(1);
      await mcp.invoke(call, async () => actor);
      expect(remote.state.calls).toBe(1);
      const second = { ...call, operationId: "write-two", args: { title: "拒绝标题" } };
      await mcp.invoke(second, async () => actor);
      const rejected = (await mcp.policy.list(group)).find(p => p.operation_id === "write-two")!;
      expect(await mcp.reviewApproval(group, rejected.id, "reject", reviewer, async () => actor)).toEqual({ status: "rejected" });
      expect((await mcp.invoke(second, async () => actor)).isError).toBe(true);
      expect(remote.state.calls).toBe(1);
      const third = { ...call, operationId: "write-three" }; await mcp.invoke(third, async () => actor);
      const frozen = (await mcp.policy.list(group)).find(p => p.operation_id === "write-three")!;
      const changed = await mcp.reviewApproval(group, frozen.id, "approve", reviewer, async () => ({ ...actor, replyChannel: "qq" }));
      expect(changed).toMatchObject({ result: { isError: true } });
      expect(remote.state.calls).toBe(1);
      await mcp.setAccess(group, "notion", { tools: [], resourceAllow: [], actors: [actor.actor], expiresAt: null }, grant.revision, reviewer);
      expect((await mcp.invoke({ ...call, operationId: "after-revoke" }, async () => actor)).isError).toBe(true);
      await mcp.close();
    });
  });
  it("does not replay an executing write after the runtime restarts", async () => {
    await env.THREAD.getByName("owner").stats();
    await runInDurableObject(env.THREAD.getByName("owner"), async (_instance, state) => {
      const db = new DurableObjectSqliteDatabase(state.storage), policy = new McpPolicyStore(db);
      const call = { authority: reviewer, server: "notion", name: "synthetic-write", contract: "contract", args: { title: "固定参数" }, operationId: "once" };
      expect(await policy.claim(call, false)).toMatchObject({ kind: "execute" });
      const restarted = new McpPolicyStore(db); await restarted.recoverInterrupted();
      const result = await restarted.claim(call, false);
      expect(result).toMatchObject({ kind: "result", result: { isError: true } });
      expect(JSON.stringify(result)).toContain("outcome_unknown");
    });
  });
});

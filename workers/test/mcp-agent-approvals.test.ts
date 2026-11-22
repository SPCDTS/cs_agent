import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { createRegistry } from "@earendil-works/pi-durable";
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { ThreadMcp, type McpAuthority } from "../src/mcp";
import { MCP_CONFIG } from "../src/mcp/config";
import { makeCatalog, MCP_CATALOG_SCHEMA } from "../src/mcp/catalog";
import { toolNames } from "../src/mcp/names";
import { createSubagentCapabilityHost } from "../src/mcp/delegated";
import { fakeRemote, login } from "./mcp-helpers";

afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const group = "group:200000001";
const actor: McpAuthority = { kind: "agent", scope: group, actor: "agent:" + group, owner: false, generation: 2, replyChannel: "qq" };
const reviewer: McpAuthority = { kind: "message", scope: "owner", actor: "admin:web", owner: true, generation: 1, replyChannel: "web" };

async function fixture(run: (mcp: ThreadMcp, db: DurableObjectSqliteDatabase, remote: ReturnType<typeof fakeRemote>, call: { name: string; args: { title: string }; operationId: string }, id: string, revoke: () => Promise<unknown>) => Promise<void>) {
  const remote = fakeRemote(); await login();
  remote.state.tools = [{ name: "notion-create-pages", inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false } }];
  await env.THREAD.getByName(group).syncAdminView(group);
  await runInDurableObject(env.THREAD.getByName(group), async (_instance, state) => {
    const db = new DurableObjectSqliteDatabase(state.storage); await db.exec(MCP_CATALOG_SCHEMA);
    const mcp = new ThreadMcp(db, env, createRegistry(), async () => actor, MCP_CONFIG, { scope: group });
    try {
      await mcp.restore();
      const catalog = makeCatalog(MCP_CONFIG.servers[0]!, remote.state.tools, MCP_CONFIG.limits).revision;
      const call = { name: toolNames(catalog, catalog.tools[0]!).nativeName, args: { title: "synthetic approved title" }, operationId: "agent-write" };
      const input = { tools: ["notion-create-pages"], resourceAllow: [], actors: [actor.actor], expiresAt: null };
      const grant = await mcp.setAccess(group, "notion", input, "none", reviewer);
      await mcp.refreshAll();
      expect(JSON.stringify(await mcp.invoke(call, async () => actor))).toContain('pending');
      const pending = (await mcp.policy.list(group))[0]!;
      expect(pending).toMatchObject({ actor: actor.actor, generation: actor.generation, reply_channel: "qq", status: "pending" });
      expect(remote.state.calls).toBe(0);
      await run(mcp, db, remote, call, pending.id, () => mcp.setAccess(group, "notion", { ...input, tools: [] }, grant.revision, reviewer));
    } finally { await mcp.close(); }
  });
}

it("executes a revalidated agent approval exactly once despite concurrent and repeated reviews", async () => {
  await fixture(async (mcp, _db, remote, call, id) => {
    const current = vi.fn(async () => actor);
    const reviews = await Promise.allSettled([1, 2].map(() => mcp.reviewApproval(group, id, "approve", reviewer, current)));
    expect(reviews.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(reviews.filter(r => r.status === "rejected")).toHaveLength(1);
    expect(reviews.find(r => r.status === "fulfilled")).toMatchObject({ value: { status: "reviewed", result: { output: expect.arrayContaining([{ type: "text", text: "service-result:" + JSON.stringify(call.args) }]) } } });
    expect(current.mock.calls.length).toBeGreaterThan(1);
    expect((await mcp.policy.approval(id, group)).status).toBe("succeeded");
    await expect(mcp.reviewApproval(group, id, "approve", reviewer, current)).rejects.toThrow("conflict");
    const receipt = await mcp.invoke(call, async () => actor);
    expect(receipt.isError).not.toBe(true);
    expect(remote.state.calls).toBe(1);
  });
});

it("rejects a revoked pending grant without executing", async () => {
  await fixture(async (mcp, _db, remote, call, id, revoke) => {
    await revoke();
    await expect(mcp.reviewApproval(group, id, "approve", reviewer, async () => actor)).rejects.toThrow("conflict");
    expect((await mcp.invoke(call, async () => actor)).isError).toBe(true);
    expect((await mcp.policy.approval(id, group)).status).toBe("rejected");
    expect(remote.state.calls).toBe(0);
  });
});

it.each([1, 5])("rechecks generation at authorization %i and records rejection, not approval or success", async at => {
  await fixture(async (mcp, _db, remote, call, id) => {
    let checks = 0;
    const reviewed = await mcp.reviewApproval(group, id, "approve", reviewer, async () => ++checks >= at ? { ...actor, generation: actor.generation + 1 } : actor);
    expect(reviewed).toMatchObject({ result: { isError: true } });
    expect(checks).toBe(at);
    expect((await mcp.policy.approval(id, group)).status).toBe("rejected");
    expect((await mcp.invoke(call, async () => actor)).isError).toBe(true);
    expect(remote.state.calls).toBe(0);
  });
});

it.each([1, 5])("rechecks grant at authorization %i including after the execution claim", async at => {
  await fixture(async (mcp, _db, remote, call, id, revoke) => {
    let checks = 0;
    const reviewed = await mcp.reviewApproval(group, id, "approve", reviewer, async () => { if (++checks === at) await revoke(); return actor; });
    expect(reviewed).toMatchObject({ result: { isError: true } });
    expect((await mcp.policy.approval(id, group)).status).toBe("rejected");
    expect((await mcp.invoke(call, async () => actor)).isError).toBe(true);
    expect(remote.state.calls).toBe(0);
  });
});

it.each(["invalid-kind", "malformed-json", "kind-changed", "owner-changed"])("fails closed for %s without leaving an executable approval", async mode => {
  await fixture(async (mcp, db, remote, call, id) => {
    if (mode === "invalid-kind" || mode === "malformed-json") await db.run("UPDATE mcp_approvals SET authority_json=? WHERE id=?", mode === "malformed-json" ? "{" : JSON.stringify({ ...actor, kind: "untrusted" }), id);
    const current = vi.fn(async () => mode === "kind-changed" ? { ...actor, kind: "message" as const } : mode === "owner-changed" ? { ...actor, owner: true } : actor);
    await mcp.reviewApproval(group, id, "approve", reviewer, current);
    if (mode === "invalid-kind" || mode === "malformed-json") expect(current).not.toHaveBeenCalled();
    expect((await mcp.policy.approval(id, group)).status).toBe("rejected");
    expect((await mcp.invoke(call, async () => actor)).isError).toBe(true);
    expect(remote.state.calls).toBe(0);
  });
});

it("preserves unknown execution outcome and never retries a dispatched write", async () => {
  await fixture(async (mcp, _db, remote, call, id) => {
    remote.state.failCalls = true;
    const result = await mcp.reviewApproval(group, id, "approve", reviewer, async () => actor);
    expect(JSON.stringify(result)).toContain("outcome_unknown");
    expect((await mcp.policy.approval(id, group)).status).toBe("unknown");
    await expect(mcp.reviewApproval(group, id, "approve", reviewer, async () => actor)).rejects.toThrow("conflict");
    expect(JSON.stringify(await mcp.invoke(call, async () => actor))).toContain("outcome_unknown");
    expect(remote.state.calls).toBe(1);
  });
});

it("rejects an unclaimed approval if current-authority lookup throws", async () => {
  await fixture(async (mcp, _db, remote, _call, id) => {
    await expect(mcp.reviewApproval(group, id, "approve", reviewer, async () => { throw new Error("synthetic-lookup-failure"); })).rejects.toThrow("synthetic-lookup-failure");
    expect((await mcp.policy.approval(id, group)).status).toBe("rejected");
    expect(remote.state.calls).toBe(0);
  });
});

it("uses the same agent authority schema for delegated capability responses", async () => {
  const host = createSubagentCapabilityHost({ validateSubagentAccess: async () => ({ authority: actor, capabilities: {} }) });
  expect(await host.validateSubagentAccess("child")).toMatchObject({ authority: actor });
  const invalid = createSubagentCapabilityHost({ validateSubagentAccess: async () => ({ authority: { ...actor, kind: "untrusted" }, capabilities: {} }) });
  await expect(invalid.validateSubagentAccess("child")).rejects.toThrow("delegation_denied");
});

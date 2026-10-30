import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRegistry } from "@earendil-works/pi-durable";
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { ThreadMcp, type McpAuthority } from "../src/mcp";
import { MCP_CATALOG_SCHEMA } from "../src/mcp/catalog";
import { sameMcpOrigin } from "../src/mcp/access";
import { installDelegatedCapabilities, type SubagentCapabilityHost } from "../src/mcp/delegated";
import { fakeRemote, login } from "./mcp-helpers";

afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const authority: McpAuthority = { kind: "message", scope: "owner", actor: "10000001", owner: true, generation: 1, replyChannel: "web" };
describe("MCP resources and delegated capabilities", () => {
  it("reads listed/template resources with configured prefixes through the shared connection", async () => {
    const remote = fakeRemote(); await login();
    await env.THREAD.getByName("owner").stats();
    await runInDurableObject(env.THREAD.getByName("owner"), async (_instance, state) => {
      const db = new DurableObjectSqliteDatabase(state.storage);
      await db.exec(MCP_CATALOG_SCHEMA);
      const mcp = new ThreadMcp(db, env, createRegistry(), async () => authority);
      const invoke = (name: string, args: unknown) => mcp.invoke({ name, args, operationId: "test" }, async () => authority);
      expect((await invoke("mcp_resources_list", { server: "notion" })).output).toEqual([{ type: "text", text: expect.stringContaining("notion://docs/start") }]);
      expect(JSON.stringify((await invoke("mcp_resources_list", { server: "notion" })).output)).not.toContain("hidden");
      expect(JSON.stringify((await invoke("mcp_resources_templates", { server: "notion" })).output)).toContain("{page}");
      expect(JSON.stringify((await invoke("mcp_resources_read", { server: "notion", uri: "notion://docs/another" })).output)).toContain("合成文档正文");
      expect((await invoke("mcp_resources_read", { server: "notion", uri: "notion://private/hidden" })).isError).toBe(true);
      expect(remote.state.resourceReads).toBe(1);
      expect(remote.requests.filter(r => r.body.includes('"method":"resources/list"'))).toHaveLength(1);
      await mcp.close();
    });
  });
  it("delegates only snapshot tools, skills and explicitly granted independent coding, preserving web origin", async () => {
    fakeRemote(); await login(); await env.THREAD.getByName("owner").stats();
    await runInDurableObject(env.THREAD.getByName("owner"), async (_instance, state) => {
      const db = new DurableObjectSqliteDatabase(state.storage); await db.exec(MCP_CATALOG_SCHEMA);
      const mcp = new ThreadMcp(db, env, createRegistry(), async () => authority); await mcp.refreshAll();
      const snapshot = await mcp.captureCapabilities(authority);
      const host: SubagentCapabilityHost = {
        validateSubagentAccess: async () => ({ authority, capabilities: { mcp: snapshot, coding: true } }),
        subagentMcp: async () => ({ output: [{ type: "text", text: "proxy" }] }),
        subagentSkill: async () => ({ output: [{ type: "text", text: "skill" }] }),
        subagentCoding: async () => ({ output: [{ type: "text", text: "sandbox" }] }),
      };
      const registry = createRegistry(), delegated = installDelegatedCapabilities(registry, host, "synthetic-child", { mcp: snapshot, coding: true });
      const names = registry.snapshot().tools().map(t => t.tool.name);
      expect(names).toEqual(expect.arrayContaining(["read_skill", "bash", "read", "write", "edit", "codemode", "mcp_resources_read"]));
      expect(names).not.toEqual(expect.arrayContaining(["send_message", "mem_remember", "skill_publish", "subagent"]));
      expect(sameMcpOrigin({ ...authority, subagentId: "synthetic-child" }, snapshot)).toBe(true);
      expect(sameMcpOrigin({ ...authority, replyChannel: "qq" }, snapshot)).toBe(false);
      expect((await mcp.invoke({ name: "mcp_resources_list", args: { server: "notion" }, operationId: "wrong-origin", snapshot }, async () => ({ ...authority, replyChannel: "qq" }))).isError).toBe(true);
      await delegated.close(); await mcp.close();
    });
  });
});

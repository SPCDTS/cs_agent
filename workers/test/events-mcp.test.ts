import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { ThreadMcp } from "../src/mcp";
import { MCP_CATALOG_SCHEMA } from "../src/mcp/catalog";
import { MCP_CONFIG, parseMcpConfig } from "../src/mcp/config";
import config from "../mcp.json";
import { fakeRemote, login } from "./mcp-helpers";

afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const text = (result: { output?: readonly unknown[] }) => JSON.stringify(result.output);

describe("MCP eventAllow", () => {
  it("must be a subset of allow and defaults to empty; Notion opens search and fetch to event turns", () => {
    const server = config.servers[0]!;
    expect(() => parseMcpConfig({ ...config, servers: [{ ...server, tools: { allow: ["notion-search"], eventAllow: ["notion-create-pages"] } }] })).toThrow("mcp_config_invalid");
    expect(parseMcpConfig({ ...config, servers: [{ ...server, tools: { allow: ["notion-search"] } }] }).servers[0]?.tools.eventAllow).toEqual([]);
    expect(MCP_CONFIG.servers[0]?.tools.eventAllow).toEqual(["notion-search", "notion-fetch"]);
  });

  it("lets event turns call only eventAllow tools and never refresh the catalog", async () => {
    const remote = fakeRemote(); await login();
    let kind: "message" | "event" = "event";
    await runInDurableObject(env.THREAD.getByName("owner"), async (_instance, state) => {
      const db = new DurableObjectSqliteDatabase(state.storage);
      await db.exec(MCP_CATALOG_SCHEMA + "CREATE TABLE IF NOT EXISTS events(at INTEGER,kind TEXT,detail TEXT)");
      const server = { ...MCP_CONFIG.servers[0]!, tools: { allow: ["notion-search", "notion-fetch"], eventAllow: ["notion-search"] } };
      const registry = createRegistry(), mcp = new ThreadMcp(db, env, registry, async () => kind, { ...MCP_CONFIG, servers: [server] });
      await mcp.refreshAll();
      const tool = (prefix: string) => registry.snapshot().tools().map(entry => entry.tool).find(candidate => candidate.name.startsWith(prefix))!;
      const api = {} as ToolExecutionApi;
      expect(text(await tool("mcp_notion_notion_search").execute({ query: "q" }, api, BACKGROUND_CONTEXT))).toContain("service-result");
      expect(text(await tool("mcp_notion_notion_fetch").execute({}, api, BACKGROUND_CONTEXT))).toContain("denied");
      expect(text(await tool("mcp_refresh_tools").execute({}, api, BACKGROUND_CONTEXT))).toContain("denied");
      kind = "message";
      expect(text(await tool("mcp_notion_notion_fetch").execute({}, api, BACKGROUND_CONTEXT))).toContain("service-result");
      await mcp.close();
    });
    expect(remote.state.calls).toBe(2);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { McpConnection } from "../../src/agent/pi-mcp/connection.js";
import { DEFAULT_MCP_LIMITS, type McpLimits } from "../../src/agent/pi-mcp/config.js";
import { httpFixture, type HttpMode } from "./fixtures/pi-mcp-http.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const live = () => new AbortController().signal;

async function open(mode: HttpMode = "json", limits: Partial<McpLimits> = {}, onToolsChanged = () => {}) {
  const fixture = await httpFixture(mode);
  cleanup.push(fixture.close);
  const connection = await McpConnection.open({ server: fixture.config, limits: { ...DEFAULT_MCP_LIMITS, ...limits },
    secrets: { readReferencedVariable: () => "Bearer SECRET_SENTINEL" }, signal: live(), onToolsChanged });
  cleanup.push(() => connection.close());
  return { fixture, connection };
}

describe("Pi MCP Streamable HTTP 单连接", () => {
  it.each(["json", "sse"] satisfies HttpMode[])("%s 完整分页、独立输出契约、凭据与通知", async mode => {
    let changed = 0;
    const { fixture, connection } = await open(mode, {}, () => changed++);
    expect((await connection.listTools(live())).map(tool => tool.name)).toEqual(["first", "second"]);
    expect(await connection.callTool("second", {}, live())).toMatchObject({ structuredContent: { value: "deliberately-invalid-schema" } });
    expect(fixture.calls).toBe(1);
    expect(fixture.headers.every(header => header.authorization === "Bearer SECRET_SENTINEL")).toBe(true);
    expect(fixture.messages.find(message => "method" in message && message.method === "initialize")).toMatchObject({ params: { capabilities: {} } });
    if (mode === "sse") expect(changed).toBe(1);
    await Promise.all([connection.close(), connection.close()]);
    await expect(connection.callTool("second", {}, live())).rejects.toMatchObject({ code: "closed" });
  });

  it.each(["duplicate-name", "duplicate-cursor"] satisfies HttpMode[])("拒绝 %s 的完整候选目录", async mode => {
    const { connection } = await open(mode);
    await expect(connection.listTools(live())).rejects.toMatchObject({ code: "protocol_error" });
  });

  it.each([{ maxPages: 1 }, { maxTools: 1 }, { catalogBytes: 1 }])("拒绝目录限额 %j", async limits => {
    const { connection } = await open("json", limits);
    await expect(connection.listTools(live())).rejects.toMatchObject({ code: "catalog_limit" });
  });

  it.each(["large-json", "large-sse", "sse-comment"] satisfies HttpMode[])("%s 在解析或流缓存前拒绝超限", async mode => {
    const { connection, fixture } = await open(mode, { messageBytes: 1024 });
    await expect(connection.callTool("first", {}, live())).rejects.toMatchObject({ code: "message_limit" });
    expect(fixture.calls).toBe(1);
  });

  it.each(["redirect", "cross-origin"] satisfies HttpMode[])("拒绝 %s 且不发送第二个请求", async mode => {
    const fixture = await httpFixture(mode); cleanup.push(fixture.close);
    await expect(McpConnection.open({ server: fixture.config, limits: DEFAULT_MCP_LIMITS, secrets: { readReferencedVariable: () => "Bearer SECRET_SENTINEL" },
      signal: live(), onToolsChanged: () => {} })).rejects.toMatchObject({ code: "transport_error" });
    expect(fixture.paths).toEqual(["/mcp"]);
  });

  it.each(["unauthorized", "forbidden", "lost", "fail"] satisfies HttpMode[])("%s 不做 OAuth、不重发业务请求、错误脱敏", async mode => {
    const { connection, fixture } = await open(mode);
    const result = await connection.callTool("first", {}, live()).catch(error => error);
    expect(result).toMatchObject({ code: mode === "unauthorized" || mode === "forbidden" ? "auth_failed" : mode === "lost" ? "remote_state_lost" : "transport_error" });
    expect(String(result)).not.toContain("SECRET");
    expect(fixture.calls).toBe(1);
  });

  it("取消已发送调用，发送 cancellation 并保持单次业务 POST", async () => {
    const { connection, fixture } = await open("hang");
    const controller = new AbortController();
    const promise = connection.callTool("first", {}, controller.signal);
    await expect.poll(() => fixture.calls).toBe(1);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    await expect.poll(() => fixture.messages.some(message => "method" in message && message.method === "notifications/cancelled")).toBe(true);
    expect(fixture.calls).toBe(1);
  });

  it("缺少秘密引用时零网络请求", async () => {
    const fixture = await httpFixture(); cleanup.push(fixture.close);
    await expect(McpConnection.open({ server: fixture.config, limits: DEFAULT_MCP_LIMITS, secrets: { readReferencedVariable: () => undefined },
      signal: live(), onToolsChanged: () => {} })).rejects.toMatchObject({ code: "missing_secret" });
    expect(fixture.paths).toEqual([]);
  });

  it("初始化信号在 open 返回后释放，不影响之后的调用", async () => {
    const fixture = await httpFixture(); cleanup.push(fixture.close);
    const controller = new AbortController();
    const connection = await McpConnection.open({ server: fixture.config, limits: DEFAULT_MCP_LIMITS, secrets: { readReferencedVariable: () => "Bearer SENTINEL" },
      signal: controller.signal, onToolsChanged: () => {} });
    cleanup.push(() => connection.close());
    controller.abort();
    expect(await connection.callTool("first", {}, live())).toMatchObject({ content: [{ text: "done" }] });
  });

  it("超时不重发，晚到响应不会交给后一个调用", async () => {
    const { connection, fixture } = await open("late", { callMs: 30 });
    await expect(connection.callTool("first", {}, live())).rejects.toMatchObject({ code: "timeout" });
    expect(await connection.callTool("second", {}, live())).toMatchObject({ content: [{ text: "done" }] });
    await new Promise<void>(resolve => setTimeout(resolve, 130));
    expect(fixture.calls).toBe(2);
  });
});

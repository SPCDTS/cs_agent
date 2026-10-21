import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { RecallTokens, startMediaRecallServer } from "../../src/context/media-recall-server.js";
import { grantsFixture } from "../agent/grants-fixture.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
/** mode：本轮身份由会话宿主给出（用户回合 / 定时回合 / 唤醒回合），租约只绑定会话与回合。 */
async function setup(owner: boolean, grant = false, mode: "user" | "scheduled" | "wake" = "user") {
  const f = await grantsFixture(owner ? "1" : "99");
  if (grant) await f.grants.panel("auth_grant", { user: "qq:1", caps: ["send"], targets: ["qq:group:8"] });
  const binding = { ...f.binding, identity: mode === "user" ? f.binding.identity : mode === "scheduled"
    ? { kind: "scheduled" as const, creator: "1" } : { kind: "wake" as const } };
  const tokens = new RecallTokens({ recall: async () => ({ text: "", images: [] }) }, 5, undefined, {
    permissions: () => f.grants.permissions(binding),
    auth: (_b, name, args) => f.grants.tool(binding, name, args),
    send: (b, callKey, args, signal) => f.service.send({ ...binding, access: b.access, workdir: b.workdir! }, args, callKey, signal),
  });
  const server = await startMediaRecallServer(tokens, 0); cleanup.push(() => server.close());
  const lease = tokens.issue({ threadKey: binding.threadKey, turnId: binding.turnId, access: binding.access, workdir: binding.workdir, deadline: Date.now() + 60_000 });
  const client = new Client({ name: "im-grants-test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("../../dist/mcp/im.js", import.meta.url))],
    env: { ...process.env, IM_TOKEN: lease.token, MEDIA_RECALL_PORT: String(server.port) } as Record<string, string>, stderr: "pipe" }));
  cleanup.push(() => client.close());
  const post = (route: string, args: unknown, token = lease.token) => fetch(`http://127.0.0.1:${server.port}/${route}`, {
    method: "POST", headers: { Authorization: "Bearer " + token }, body: JSON.stringify(args),
  });
  return { ...f, client, lease, tokens, post };
}

it.each([[true, false], [false, true], [false, false]])("im 子进程按令牌声明暴露工具和 target（owner=%s grant=%s）", async (owner, grant) => {
  const f = await setup(owner!, grant!);
  const tools = (await f.client.listTools()).tools;
  expect(tools.map(t => t.name)).toEqual(owner ? ["send_message", "auth_grant", "auth_revoke", "auth_list"] : ["send_message"]);
  expect(tools[0]!.inputSchema.properties).toHaveProperty("text");
  expect(Object.hasOwn(tools[0]!.inputSchema.properties!, "target")).toBe(owner || grant);
  if (owner || grant) {
    const sent = await f.client.callTool({ name: "send_message", arguments: { target: "qq:group:8", text: "目标消息" } });
    expect(sent.isError).not.toBe(true);
    expect(f.store.listOutboxByTurn(f.binding.turnId)[0]!.target_id).toBe("8");
  } else {
    expect((await f.client.callTool({ name: "send_message", arguments: { target: "qq:group:8", text: "拒绝" } })).isError).toBe(true);
  }
});

it("owner 工具增删查与 trace；额外 actor 参数不能改变授权者", async () => {
  const f = await setup(true);
  expect((await f.client.callTool({ name: "auth_grant", arguments: { user: "qq:9", caps: ["send", "schedule"], targets: ["qq:group:8"] } })).isError).not.toBe(true);
  expect((await f.grants.list())[0]!.granted_by).toBe("qq:1");
  const listed = await f.client.callTool({ name: "auth_list", arguments: {} });
  expect(JSON.stringify(listed.content)).toContain("qq:9");
  expect((await f.post("auth_grant", { user: "qq:9", caps: ["send"], actor: "qq:99" })).status).toBe(400);
  expect((await f.client.callTool({ name: "auth_revoke", arguments: { user: "qq:9" } })).isError).not.toBe(true);
  expect(await f.grants.list()).toEqual([]);
  expect(f.event.mock.calls.map(c => c[1])).toEqual(["auth_changed", "auth_changed"]);
});

it("非 owner 不能直接调用隐藏工具或回环端点；撤销后令牌失效", async () => {
  const f = await setup(false);
  for (const name of ["auth_grant", "auth_revoke", "auth_list"]) {
    expect((await f.client.callTool({ name, arguments: {} })).isError).toBe(true);
    expect((await f.post(name, {})).status).toBe(400);
  }
  f.lease.revoke();
  expect((await f.post("auth_list", {})).status).toBe(401);
});

it("owner 线程的唤醒回合只开放发往本会话：无 target、无授权工具，跨会话发送在主进程拒绝", async () => {
  const f = await setup(true, false, "wake");
  const tools = (await f.client.listTools()).tools;
  expect(tools.map(t => t.name)).toEqual(["send_message"]);
  expect(Object.hasOwn(tools[0]!.inputSchema.properties!, "target")).toBe(false);
  expect((await f.post("auth_list", {})).status).toBe(400);
  expect((await f.post("send", { target: "qq:group:8", text: "越权" })).status).toBe(400);
  expect((await f.client.callTool({ name: "send_message", arguments: { text: "汇报" } })).isError).not.toBe(true);
  expect(f.store.listOutboxByTurn(f.binding.turnId).map(row => row.target_id)).toEqual(["7"]);
});

it("已启动的 im schema 不赋予持久权限，授权撤销后跨目标发送在主进程拒绝", async () => {
  const f = await setup(false, true);
  expect((await f.client.listTools()).tools[0]!.inputSchema.properties).toHaveProperty("target");
  await f.grants.panel("auth_revoke", { user: "qq:1" });
  expect((await f.client.callTool({ name: "send_message", arguments: { target: "qq:group:8", text: "已撤销" } })).isError).toBe(true);
  expect(f.store.listOutboxByTurn(f.binding.turnId)).toHaveLength(0);
});


it.each([true, false])("定时回合 owner=%s 的 MCP 和 HTTP 均不开放 auth，保留有权 target", async owner => {
  const f = await setup(owner, !owner, "scheduled");
  const tools = (await f.client.listTools()).tools;
  expect(tools.map(t => t.name)).toEqual(["send_message"]);
  expect(tools[0].inputSchema.properties).toHaveProperty("target");
  for (const name of ["auth_grant", "auth_revoke", "auth_list"]) {
    expect((await f.client.callTool({ name, arguments: {} })).isError).toBe(true);
    expect((await f.post(name, {})).status).toBe(400);
  }
  expect((await f.client.callTool({ name: "send_message", arguments: { target: "qq:group:8", text: "定时通知" } })).isError).not.toBe(true);
});

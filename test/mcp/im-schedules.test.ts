import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { RecallTokens, startMediaRecallServer } from "../../src/context/media-recall-server.js";
import { SCHEDULE_MANAGEMENT_TOOLS } from "../../src/shared/schedule-tools.js";
import type { GrantBinding } from "../../src/agent/grants.js";
import { scheduleToolsFixture } from "../agent/schedule-tools-fixture.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup(user = "1", grant = false, scheduled = false) {
  const f = await scheduleToolsFixture();
  if (grant) await f.grants.panel("auth_grant", { user: `qq:${user}`, caps: ["schedule"], scopes: ["group:7"] });
  let binding = f.binding(user);
  const own = scheduled ? await f.create(binding) : undefined;
  if (own) binding = await f.scheduled(own.id, binding.actor);
  // 租约只绑定会话与回合；网关按回合 id 取回宿主给出的本轮绑定（测试中由 turns 表模拟）。
  const turns = new Map<string, GrantBinding>();
  const turnOf = (b: { turnId: string }) => turns.get(b.turnId)!;
  const tokens = new RecallTokens({ recall: async () => ({ text: "", images: [] }) }, 5, undefined, {
    permissions: async b => ({ ...await f.grants.permissions(turnOf(b)), ...await f.tools.permissions(turnOf(b)) }),
    schedule: (b, name, args) => f.tools.tool(turnOf(b), name, args),
    send: async () => { throw new Error("本测试不发送"); },
  });
  const server = await startMediaRecallServer(tokens, 0); cleanup.push(() => server.close());
  const issue = (b: GrantBinding, deadline = Date.now() + 60_000) => {
    const turnId = "turn-" + (turns.size + 1);
    turns.set(turnId, b);
    return tokens.issue({ threadKey: b.threadKey, turnId, deadline, access: { kind: "all" } });
  };
  const lease = issue(binding);
  const client = new Client({ name: "schedule-test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("../../dist/mcp/im.js", import.meta.url))],
    env: { ...process.env, IM_TOKEN: lease.token, MEDIA_RECALL_PORT: String(server.port) } as Record<string, string>, stderr: "pipe" }));
  cleanup.push(() => client.close());
  const post = (name: string, args: unknown, token = lease.token) => fetch(`http://127.0.0.1:${server.port}/${name}`, {
    method: "POST", headers: { Authorization: "Bearer " + token }, body: JSON.stringify(args),
  });
  return { ...f, own, makeBinding: f.binding, binding, client, tokens, issue, lease, post };
}

it.each([
  ["1", false, false], ["9", true, false], ["9", false, false], ["1", false, true], ["9", true, true],
] as const)("真实 im 子进程工具矩阵 actor=%s grant=%s scheduled=%s", async (user, grant, scheduled) => {
  const f = await setup(user, grant, scheduled);
  const visible = (await f.client.listTools()).tools.filter(t => t.name.startsWith("schedule_"));
  expect(visible.map(t => t.name)).toEqual(scheduled ? ["schedule_control"] : user === "1" || grant ? [...SCHEDULE_MANAGEMENT_TOOLS] : []);
  if (scheduled || user === "9" && !grant) for (const name of SCHEDULE_MANAGEMENT_TOOLS) {
    expect((await f.client.callTool({ name, arguments: {} })).isError).toBe(true);
    expect((await f.post(name, {})).status).toBe(400);
  }
  if (!scheduled) {
    const args = { action: "complete", reason: "伪造定时回合" };
    expect((await f.client.callTool({ name: "schedule_control", arguments: args })).isError).toBe(true);
    expect((await f.post("schedule_control", args)).status).toBe(400);
  } else {
    expect(visible[0].inputSchema.properties).not.toHaveProperty("id");
    const result = await f.client.callTool({ name: "schedule_control", arguments: { action: "complete", reason: "监控结束" } });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain(f.own!.id);
    expect((await f.service.get(f.own!.id))?.status).toBe("completed");
  }
});

it("codex 创建、列出、更新、暂停、恢复、立即运行和删除；大于 2 KiB 的中文 prompt 完整保存", async () => {
  const f = await setup(), args = { ...f.args, prompt: "检查资讯，更新时发到 qq:group:7；".repeat(150) };
  const created = await f.client.callTool({ name: "schedule_create", arguments: args });
  expect(created.isError).not.toBe(true);
  const schedule = (await f.service.list())[0]!;
  expect(schedule).toMatchObject({ prompt: args.prompt, created_by: "qq:1", conversation: "group:7" });
  expect(JSON.stringify(created.content)).toContain("北京时间");
  expect(JSON.stringify(created.content)).toContain(schedule.id);
  expect(JSON.stringify((await f.client.callTool({ name: "schedule_list" })).content)).toContain(schedule.id);
  for (const name of ["schedule_update", "schedule_pause", "schedule_resume", "schedule_run_now", "schedule_delete"] as const) {
    const result = await f.client.callTool({ name, arguments: { id: schedule.id,
      ...(name === "schedule_update" ? { name: "更名", prompt: args.prompt } : {}) } });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain(schedule.id);
  }
  expect(await f.service.list()).toEqual([]);
});

it("HTTP 不接受模型传入的身份或来源，授权人不能操作 owner 的任务；唤醒回合没有定时工具", async () => {
  const f = await setup("9", true), ownerSchedule = await f.create(f.makeBinding("1"));
  for (const extra of [{ actor: "qq:1" }, { created_by: "qq:1" }, { conversation: "owner" }]) {
    expect((await f.post("schedule_create", { ...f.args, ...extra })).status).toBe(400);
  }
  for (const name of ["schedule_update", "schedule_pause", "schedule_resume", "schedule_delete", "schedule_run_now"]) {
    expect((await f.post(name, { id: ownerSchedule.id })).status).toBe(400);
  }
  expect(JSON.stringify(await (await f.post("schedule_list", {})).json())).not.toContain(ownerSchedule.id);
  const wake = f.issue({ ...f.makeBinding("1"), identity: { kind: "wake" } });
  expect((await f.post("schedule_create", f.args, wake.token)).status).toBe(400);
  expect((await f.post("schedule_list", {}, wake.token)).status).toBe(400);
  expect(await f.service.get(ownerSchedule.id)).toEqual(ownerSchedule);
});

it("HTTP 控制只取令牌所属的持久运行绑定；跨任务 id 不生效", async () => {
  const f = await setup("1", false, true), other = await f.create(f.makeBinding("1"));
  expect((await f.post("schedule_control", { action: "pause", reason: "结束", id: other.id })).status).toBe(400);
  expect((await f.post("schedule_control", { action: "pause", reason: "等待更新" })).status).toBe(200);
  expect((await f.service.get(f.own!.id))?.status).toBe("paused");
  expect(await f.service.get(other.id)).toEqual(other);
});

it("schema 已缓存也要在端点复核授权；撤销、作废和过期令牌均无副作用", async () => {
  const f = await setup("9", true);
  expect((await f.client.listTools()).tools.some(t => t.name === "schedule_create")).toBe(true);
  await f.grants.panel("auth_revoke", { user: "qq:9" });
  expect((await f.client.callTool({ name: "schedule_create", arguments: f.args })).isError).toBe(true);
  expect((await f.post("schedule_create", f.args)).status).toBe(400);
  f.lease.revoke();
  expect((await f.post("schedule_list", {})).status).toBe(401);
  const expiring = f.issue(f.binding, Date.now() + 1);
  await new Promise(resolve => setTimeout(resolve, 5));
  expect((await f.post("schedule_list", {}, expiring.token)).status).toBe(401);
  expect(await f.service.list()).toEqual([]);
});

import path from "node:path";
import { expect, it } from "vitest";
import { grantsFixture } from "../agent/grants-fixture.js";
import { imRig } from "./im-fixture.js";

/** mode：本轮身份由会话宿主给出（用户回合 / 定时回合 / 唤醒回合）；令牌只绑定会话，身份在每次调用时求出。 */
async function setup(owner: boolean, grant = false, mode: "user" | "scheduled" | "wake" = "user") {
  const f = await grantsFixture(owner ? "1" : "99");
  if (grant) await f.grants.panel("auth_grant", { user: "qq:1", caps: ["send"], targets: ["qq:group:8"] });
  const binding = { ...f.binding, session: "thr-1", imageDir: path.join(f.dir, "images", "group_7"),
    identity: mode === "user" ? f.binding.identity : mode === "scheduled" ? { kind: "scheduled" as const, creator: "1" } : { kind: "wake" as const } };
  const rig = await imRig(binding.threadKey, {
    resolve: () => binding,
    permissions: b => f.grants.permissions(b),
    auth: (b, name, args) => f.grants.tool(b, name, args),
    send: (b, callKey, args, signal) => f.service.send(b, args, callKey, signal),
  });
  return { ...f, ...rig, binding };
}

it.each([[true, false], [false, true], [false, false]])("im 工具清单固定为全集，target 按本次调用的身份在主进程校验（owner=%s grant=%s）", async (owner, grant) => {
  const f = await setup(owner!, grant!);
  const tools = (await f.client.listTools()).tools;
  expect(tools.map(t => t.name).slice(0, 2)).toEqual(["send_message", "auth"]);
  expect(Object.hasOwn(tools[0]!.inputSchema.properties!, "target")).toBe(true);
  const sent = await f.tool("send_message", { target: "qq:group:8", text: "目标消息" });
  if (owner || grant) {
    expect(sent.isError).not.toBe(true);
    expect(f.store.listOutboxByTurn(f.binding.turnId)[0]!.target_id).toBe("8");
  } else {
    expect(sent.isError).toBe(true);
    expect(f.store.listOutboxByTurn(f.binding.turnId)).toHaveLength(0);
  }
});

it("owner 工具增删查与 trace；额外 actor 参数不能改变授权者", async () => {
  const f = await setup(true);
  expect((await f.tool("auth", { action: "grant", user: "qq:9", caps: ["send", "schedule"], targets: ["qq:group:8"] })).isError).not.toBe(true);
  expect((await f.grants.list())[0]!.granted_by).toBe("qq:1");
  const listed = await f.tool("auth", { action: "list" });
  expect(JSON.stringify(listed.content)).toContain("qq:9");
  expect((await f.post("auth_grant", { user: "qq:9", caps: ["send"], actor: "qq:99" })).status).toBe(400);
  expect((await f.tool("auth", { action: "revoke", user: "qq:9" })).isError).not.toBe(true);
  expect(await f.grants.list()).toEqual([]);
  expect(f.event.mock.calls.map(c => c[1])).toEqual(["auth_changed", "auth_changed"]);
});

it("非 owner 回合调用授权工具在主进程拒绝；作废后令牌失效", async () => {
  const f = await setup(false);
  for (const action of ["grant", "revoke", "list"]) {
    const args = action === "grant" ? { user: "qq:9", caps: ["send"] } : action === "revoke" ? { user: "qq:9" } : {};
    const denied = await f.tool("auth", { action, ...args });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.content)).toContain("owner");
    expect((await f.post(`auth_${action}`, args)).status).toBe(400);
  }
  f.tokens.revoke(f.binding.threadKey);
  expect((await f.post("auth_list", {})).status).toBe(401);
});

it("没有继承身份的唤醒回合（owner 线程也一样）只开放发往本会话：无 target、无授权工具，跨会话发送在主进程拒绝", async () => {
  const f = await setup(true, false, "wake");
  expect((await f.post("auth_list", {})).status).toBe(400);
  expect((await f.post("send", { target: "qq:group:8", text: "越权" })).status).toBe(400);
  expect((await f.tool("auth", { action: "list" })).isError).toBe(true);
  expect((await f.tool("send_message", { text: "汇报" })).isError).not.toBe(true);
  expect(f.store.listOutboxByTurn(f.binding.turnId).map(row => row.target_id)).toEqual(["7"]);
});

it("授权撤销后跨目标发送在主进程拒绝（MCP 进程跨回合复用，不缓存权限）", async () => {
  const f = await setup(false, true);
  expect((await f.tool("send_message", { target: "qq:group:8", text: "授权内" })).isError).not.toBe(true);
  await f.grants.panel("auth_revoke", { user: "qq:1" });
  expect((await f.tool("send_message", { target: "qq:group:8", text: "已撤销" })).isError).toBe(true);
  expect(f.store.listOutboxByTurn(f.binding.turnId)).toHaveLength(1);
});


it.each([true, false])("定时回合 owner=%s 的 MCP 和 HTTP 均不开放 auth，保留有权 target", async owner => {
  const f = await setup(owner, !owner, "scheduled");
  for (const action of ["grant", "revoke", "list"]) {
    const args = action === "grant" ? { user: "qq:9", caps: ["send"] } : action === "revoke" ? { user: "qq:9" } : {};
    const denied = await f.tool("auth", { action, ...args });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.content)).toContain("owner");
    expect((await f.post(`auth_${action}`, args)).status).toBe(400);
  }
  expect((await f.tool("send_message", { target: "qq:group:8", text: "定时通知" })).isError).not.toBe(true);
});

it("auth 使用扁平 schema，拒绝未知动作、缺失字段、跨动作字段和旧工具名", async () => {
  const f = await setup(true);
  const schema = (await f.client.listTools()).tools.find(t => t.name === "auth")!.inputSchema;
  expect(schema.required).toEqual(["action"]);
  expect(schema.properties!.action).toMatchObject({ enum: ["grant", "revoke", "list"] });
  expect(schema).not.toHaveProperty("anyOf"); expect(schema).not.toHaveProperty("oneOf");
  for (const args of [{}, { action: "unknown" }]) {
    const result = await f.tool("auth", args);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("auth action is required and must be one of");
  }
  for (const args of [{ action: "grant", user: "qq:9" }, { action: "revoke" },
    { action: "revoke", user: "qq:9", targets: [] }, { action: "list", user: "qq:9" }]) {
    expect((await f.tool("auth", args)).isError).toBe(true);
  }
  expect((await f.tool("auth_list")).isError).toBe(true);
  expect(await f.grants.list()).toEqual([]);
  expect(f.event).not.toHaveBeenCalled();
});

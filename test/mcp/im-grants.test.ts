import path from "node:path";
import { expect, it } from "vitest";
import { grantsFixture } from "../agent/grants-fixture.js";
import { imRig } from "./im-fixture.js";

/** mode：本轮身份由会话宿主给出（用户回合 / 定时回合 / 唤醒回合）；令牌只绑定会话，身份在每次调用时求出。 */
async function setup(owner: boolean, grant = false, mode: "user" | "scheduled" | "wake" = "user") {
  const f = await grantsFixture(owner ? "1" : "99");
  if (grant) await f.grants.panel("auth_grant", { user: "qq:1", caps: ["send"], targets: ["qq:group:8"] });
  const binding = { ...f.binding, session: "thr-1", imageDir: path.join(f.dir, "images", "group_7"), imageRefs: [],
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
  expect(tools.map(t => t.name).slice(0, 4)).toEqual(["send_message", "auth_grant", "auth_revoke", "auth_list"]);
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
  expect((await f.tool("auth_grant", { user: "qq:9", caps: ["send", "schedule"], targets: ["qq:group:8"] })).isError).not.toBe(true);
  expect((await f.grants.list())[0]!.granted_by).toBe("qq:1");
  const listed = await f.tool("auth_list", {});
  expect(JSON.stringify(listed.content)).toContain("qq:9");
  expect((await f.post("auth_grant", { user: "qq:9", caps: ["send"], actor: "qq:99" })).status).toBe(400);
  expect((await f.tool("auth_revoke", { user: "qq:9" })).isError).not.toBe(true);
  expect(await f.grants.list()).toEqual([]);
  expect(f.event.mock.calls.map(c => c[1])).toEqual(["auth_changed", "auth_changed"]);
});

it("非 owner 回合调用授权工具在主进程拒绝；作废后令牌失效", async () => {
  const f = await setup(false);
  for (const name of ["auth_grant", "auth_revoke", "auth_list"]) {
    expect((await f.tool(name, {})).isError).toBe(true);
    expect((await f.post(name, {})).status).toBe(400);
  }
  f.tokens.revoke(f.binding.threadKey);
  expect((await f.post("auth_list", {})).status).toBe(401);
});

it("owner 线程的唤醒回合只开放发往本会话：授权工具与跨会话发送在主进程拒绝", async () => {
  const f = await setup(true, false, "wake");
  expect((await f.post("auth_list", {})).status).toBe(400);
  expect((await f.post("send", { target: "qq:group:8", text: "越权" })).status).toBe(400);
  expect((await f.tool("auth_list", {})).isError).toBe(true);
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
  for (const name of ["auth_grant", "auth_revoke", "auth_list"]) {
    expect((await f.tool(name, {})).isError).toBe(true);
    expect((await f.post(name, {})).status).toBe(400);
  }
  expect((await f.tool("send_message", { target: "qq:group:8", text: "定时通知" })).isError).not.toBe(true);
});

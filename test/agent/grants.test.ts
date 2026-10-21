import { expect, it } from "vitest";
import { GrantsDoc } from "../../src/agent/docs.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { grantsFixture } from "./grants-fixture.js";

it("授权存于派发 Session 文档，重开后保留；更新替换授权并保留创建时间", async () => {
  const f = await grantsFixture("1", true);
  await f.grants.tool(f.binding, "auth_grant", { user: "qq:9", caps: ["send", "schedule"], targets: ["qq:group:8"], expires_in_hours: 2 });
  const before = (await f.grants.list())[0]!;
  expect(await f.harness().snapshot(GrantsDoc, BACKGROUND_CONTEXT)).toHaveProperty("qq:9");
  await f.reopen();
  expect((await f.grants.list())[0]).toEqual(before);
  f.advance(1000);
  await f.grants.panel("auth_grant", { user: "qq:9", caps: ["schedule"] });
  expect((await f.grants.list())[0]).toEqual({
    user: "qq:9", caps: ["schedule"], targets: [], granted_by: "qq:1",
    created_at: before.created_at, updated_at: f.now(), expired: false,
  });
  expect(f.event.mock.calls.map(c => c[2].detail.source)).toEqual(["tool", "panel"]);
  expect(f.event.mock.calls[1]![2].detail).toMatchObject({ before: { caps: ["send", "schedule"] }, after: { caps: ["schedule"] } });
});

it("到期边界视为不存在，面板显示已过期；scope 缺省、空数组和精确来源分别判定", async () => {
  const f = await grantsFixture("99");
  const grant = { user: "qq:1", caps: ["send"], targets: ["qq:group:8"] };
  for (const scopes of [[], ["private:1"], ["group:7"], undefined]) {
    await f.grants.panel("auth_grant", { ...grant, ...(scopes ? { scopes } : {}), expires_in_hours: 1 });
    expect((await f.grants.permissions(f.binding)).target).toBe(scopes === undefined || scopes.includes("group:7"));
  }
  f.advance(3_600_000);
  expect((await f.grants.permissions(f.binding)).target).toBe(false);
  expect((await f.grants.list())[0]!.expired).toBe(true);
  await expect(f.grants.authorizeSend(f.binding, "qq:group:8")).rejects.toThrow("有效");
});

it("schedule 不授予 send；只授权来源目标时不开放 target；owner 恒有权限", async () => {
  const f = await grantsFixture("99");
  for (const data of [{ caps: ["schedule"], targets: ["qq:group:8"] }, { caps: ["send"], targets: [] }, { caps: ["send"], targets: ["qq:group:7"] }]) {
    await f.grants.panel("auth_grant", { user: "qq:1", ...data });
    expect(await f.grants.permissions(f.binding)).toEqual({ actorIsOwner: false, target: false, auth: false });
  }
  const owner = await grantsFixture();
  expect(await owner.grants.permissions(owner.binding)).toEqual({ actorIsOwner: true, target: true, auth: true });
});

it("按 cap 撤销保留剩余授权，全撤销删除；不存在的授权撤销不重复记 trace", async () => {
  const f = await grantsFixture();
  await f.grants.panel("auth_grant", { user: "qq:9", caps: ["send", "schedule"], targets: ["qq:group:8"] });
  await f.grants.tool(f.binding, "auth_revoke", { user: "qq:9", caps: ["send"] });
  expect((await f.grants.list())[0]!.caps).toEqual(["schedule"]);
  await f.grants.tool(f.binding, "auth_revoke", { user: "qq:9" });
  await f.grants.tool(f.binding, "auth_revoke", { user: "qq:9" });
  expect(await f.grants.tool(f.binding, "auth_list", {})).toEqual([]);
  expect(f.event).toHaveBeenCalledTimes(3);
});

it("非 owner 直接调用全部 auth 工具均拒绝；非法身份或会话地址拒绝；唤醒回合没有任何主动权限", async () => {
  const f = await grantsFixture("99");
  for (const name of ["auth_grant", "auth_revoke", "auth_list"] as const) {
    await expect(f.grants.tool(f.binding, name, {})).rejects.toThrow("owner");
  }
  await expect(f.grants.permissions({ ...f.binding, identity: { kind: "user", sender: "01" } })).rejects.toThrow("身份");
  await expect(f.grants.permissions({ ...f.binding, scope: "all" })).rejects.toThrow("地址");
  // owner 线程的唤醒回合同样没有 target / 授权：需要别的权限时由模型在本会话请用户确认。
  const owner = await grantsFixture();
  for (const g of [f, owner]) {
    const wake = { ...g.binding, identity: { kind: "wake" as const } };
    expect(await g.grants.permissions(wake)).toEqual({ actorIsOwner: false, target: false, auth: false });
    await expect(g.grants.authorizeSend(wake, "qq:group:8")).rejects.toThrow("唤醒");
    await expect(g.grants.tool(wake, "auth_list", {})).rejects.toThrow("owner");
  }
});

it.each([
  { user: "__proto__", caps: ["send"] }, { user: "qq:01", caps: ["send"] },
  { user: "qq:9", caps: [] }, { user: "qq:9", caps: ["admin"] },
  { user: "qq:9", caps: ["send"], targets: ["qq:group:0"] },
  { user: "qq:9", caps: ["send"], scopes: ["all"] },
  { user: "qq:9", caps: ["send"], expires_in_hours: -1 },
  { user: "qq:9", caps: ["send"], granted_by: "qq:1" },
  { user: "qq:9\n", caps: ["send"] }, { user: "qq:9", caps: ["send"], targets: ["qq:group:8\n"] },
])("非法授权不修改持久状态：%j", async args => {
  const f = await grantsFixture();
  await expect(f.grants.tool(f.binding, "auth_grant", args)).rejects.toThrow();
  expect(await f.grants.list()).toEqual([]); expect(f.event).not.toHaveBeenCalled();
});

it("canSchedule 按创建者检查 schedule cap、来源和到期边界；owner 不依赖 grant", async () => {
  const f = await grantsFixture();
  expect(await f.grants.canSchedule("qq:1", "owner")).toBe(true);
  expect(await f.grants.canSchedule("qq:9", "group:7")).toBe(false);
  await f.grants.panel("auth_grant", { user: "qq:9", caps: ["send"], scopes: ["group:7"] });
  expect(await f.grants.canSchedule("qq:9", "group:7")).toBe(false);
  await f.grants.panel("auth_grant", { user: "qq:9", caps: ["schedule"], scopes: ["group:7"], expires_in_hours: 1 });
  expect(await f.grants.canSchedule("qq:9", "group:7")).toBe(true);
  expect(await f.grants.canSchedule("qq:9", "group:8")).toBe(false);
  expect(await f.grants.canSchedule("qq:9", "owner")).toBe(false);
  f.advance(3_600_000);
  expect(await f.grants.canSchedule("qq:9", "group:7")).toBe(false);
  expect(await f.grants.canSchedule("qq:1", "group:7")).toBe(true);
  await f.grants.panel("auth_grant", { user: "qq:9", caps: ["schedule"] });
  expect(await f.grants.canSchedule("qq:9", "private:8")).toBe(true);
  await f.grants.panel("auth_grant", { user: "qq:9", caps: ["schedule"], scopes: [] });
  expect(await f.grants.canSchedule("qq:9", "group:7")).toBe(false);
});


it.each(["1", "99"])("定时回合禁止 auth 工具，仍按创建者 %s 保留发送权限", async owner => {
  const f = await grantsFixture(owner);
  if (owner !== "1") await f.grants.panel("auth_grant", { user: "qq:1", caps: ["send"], targets: ["qq:group:8"] });
  const binding = { ...f.binding, identity: { kind: "scheduled" as const, creator: "1" }, inputs: ["run_" + "a".repeat(40)] };
  expect(await f.grants.permissions(binding)).toEqual({ actorIsOwner: owner === "1", auth: false, target: true });
  for (const name of ["auth_grant", "auth_revoke", "auth_list"] as const) {
    await expect(f.grants.tool(binding, name, {})).rejects.toThrow("交互");
  }
  await expect(f.grants.authorizeSend(binding, "qq:group:8")).resolves.toBeUndefined();
});

it("第二 owner 具备完整授权和定时权限，面板仍使用主账号", async () => {
  const f = await grantsFixture("99", false, ["99", "1"]);
  expect(await f.grants.permissions(f.binding)).toEqual({ actorIsOwner: true, target: true, auth: true });
  await expect(f.grants.authorizeSend(f.binding, "qq:private:9")).resolves.toBeUndefined();
  expect(await f.grants.canSchedule("qq:1", "owner")).toBe(true);
  expect(await f.grants.canSchedule("qq:1", "group:8")).toBe(true);
  expect(await f.grants.canSchedule("qq:9", "owner")).toBe(false);
  await f.grants.tool(f.binding, "auth_grant", { user: "qq:9", caps: ["schedule"] });
  expect((await f.grants.list())[0]).toMatchObject({ granted_by: "qq:1" });
  await f.grants.panel("auth_grant", { user: "qq:9", caps: ["send"] });
  expect((await f.grants.list())[0]).toMatchObject({ granted_by: "qq:99" });
  await f.grants.tool(f.binding, "auth_revoke", { user: "qq:9" });
  expect(await f.grants.tool(f.binding, "auth_list", {})).toEqual([]);
  expect(await f.grants.permissions({ ...f.binding, identity: { kind: "user", sender: "9" } })).toEqual({ actorIsOwner: false, target: false, auth: false });
});

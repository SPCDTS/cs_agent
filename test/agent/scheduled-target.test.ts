import { expect, it } from "vitest";
import { grantsFixture } from "./grants-fixture.js";

const runTicket = (n: number) => "run_" + n.toString(16).padStart(40, "0");

it.each(["1", "99"])("定时创建者授权（owner=%s）与默认发送、target 均可发送（无每轮上限）且均不 @", async owner => {
  const f = await grantsFixture(owner), ticket = runTicket(1);
  await f.bridge.openOutbound(ticket, { origin: "scheduled", message_type: "group", target_id: "7", user_id: "1" });
  const binding = { ...f.binding, ticket };
  if (owner !== "1") await f.grants.panel("auth_grant", {
    user: "qq:1", caps: ["send", "schedule"], targets: ["qq:group:8", "qq:private:9"], scopes: ["group:7"],
  });
  const targets = [undefined, "qq:group:8", "qq:private:9", "qq:group:7", "qq:group:8"];
  for (const [i, target] of targets.entries()) {
    await f.service.send(binding, { text: `定时通知${i}`, ...(target ? { target } : {}) }, { callId: `send-${i}` });
  }
  await f.service.send(binding, { text: "第六条", target: "qq:private:9" }, { callId: "six" });
  expect(await f.service.send(binding, { text: "定时通知1", target: "qq:group:8" }, { callId: "send-1" }))
    .toMatchObject({ already_sent: true, target_id: "8" });
  const rows = f.service.rows(ticket);
  expect(rows.map(row => row.target_id)).toEqual(["7", "8", "9", "7", "8", "9"]);
  expect(rows.every(row => row.status === "sent" && row.mention_user_id === null)).toBe(true);
  expect(f.call.mock.calls.filter(([action]) => action.startsWith("send_")).every(([, params]) =>
    !(params!.message as { type: string }[]).some(segment => segment.type === "at"))).toBe(true);
  expect(f.history.message({ kind: "scope", scope: "group:8" }, rows[1]!.message_id!)?.row.text).toBe("定时通知1");
});

it("定时私聊按来源目标匹配 grant.scopes，actor 始终是创建者；撤销和伪造身份均拒绝", async () => {
  const f = await grantsFixture("99"), ticket = runTicket(2);
  await f.bridge.openOutbound(ticket, { origin: "scheduled", message_type: "private", target_id: "1", user_id: "9" });
  const binding = { ...f.binding, ticket, actor: "qq:9", actorIsOwner: false,
    source: { type: "private" as const, user_id: "9", group_id: null },
    access: { kind: "scope" as const, scope: "private:1" } };
  await f.grants.panel("auth_grant", { user: "qq:9", caps: ["send"], targets: ["qq:group:8"], scopes: ["private:9"] });
  await expect(f.service.send(binding, { text: "错误来源授权", target: "qq:group:8" }, { callId: "wrong" })).rejects.toThrow("授权");
  await f.grants.panel("auth_grant", { user: "qq:9", caps: ["send"], targets: ["qq:group:8"], scopes: ["private:1"] });
  expect(await f.grants.verify(binding)).toEqual({ actor: "qq:9", actorIsOwner: false, scope: "private:1", origin: "scheduled" });
  expect(await f.grants.permissions(binding)).toEqual({ actorIsOwner: false, target: true, auth: false });
  await f.service.send(binding, { text: "默认会话" }, { callId: "source" });
  await f.service.send(binding, { text: "显式来源", target: "qq:private:1" }, { callId: "explicit" });
  expect(f.listChats).not.toHaveBeenCalled();
  await expect(f.service.send(binding, { text: "不能误当默认会话", target: "qq:private:9" }, { callId: "creator" })).rejects.toThrow("授权");
  await expect(f.service.send({ ...binding, actor: "qq:1" }, { text: "伪造身份", target: "qq:group:8" }, { callId: "spoof" })).rejects.toThrow("身份");
  await f.service.send(binding, { text: "授权通知", target: "qq:group:8" }, { callId: "target" });
  await f.grants.panel("auth_revoke", { user: "qq:9" });
  await expect(f.service.send(binding, { text: "撤销后", target: "qq:group:8" }, { callId: "revoked" })).rejects.toThrow("授权");
  expect(f.service.rows(ticket).map(row => row.target_id)).toEqual(["1", "1", "8"]);
});

it("定时默认发送与普通跨会话发送共用每日 ref 额度，事务预留阻止并发超额", async () => {
  const f = await grantsFixture(), ticket = runTicket(3);
  await f.bridge.openOutbound(ticket, { origin: "scheduled", message_type: "group", target_id: "7", user_id: "1" });
  for (let i = 0; i < 99; i++) f.store.reserveOutbox({
    ticket: `quota_${i}`, proactive: true, call_id: null, message_type: "group", target_id: "7",
    mention_user_id: null, text: "已有额度", images: [], files: [],
  });
  const incoming = f.store.createTicket({ ...f.msg, message_type: "private", group_id: null, message_id: "private" });
  f.listChats.mockResolvedValue({ groups: [{ group_id: "7", name: "来源群" }], friends: [] });
  const attempts = await Promise.allSettled([
    f.service.send({ ...f.binding, ticket }, { text: "定时第100条" }, { callId: "last" }),
    f.service.send({ ...f.binding, ticket: incoming, source: { type: "private", user_id: "1", group_id: null } },
      { text: "主动第100条", target: "qq:group:7" }, { callId: "last" }),
  ]);
  expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(attempts.filter(result => result.status === "rejected")).toHaveLength(1);
  await expect(f.service.send({ ...f.binding, ticket }, { text: "默认超额" }, { callId: "over" })).rejects.toThrow("100 条");
  await expect(f.service.send({ ...f.binding, ticket }, { text: "显式超额", target: "qq:group:7" }, { callId: "over" })).rejects.toThrow("100 条");
});

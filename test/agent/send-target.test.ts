import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { expect, it } from "vitest";
import { trace } from "../../src/shared/trace.js";
import { grantsFixture } from "./grants-fixture.js";

it.each(["qq:group:8", "qq:private:9"])("target %s 不 @，Outbox、文件和机器人历史均写到目标", async target => {
  const f = await grantsFixture(), events: unknown[] = [];
  const off = trace.tap(e => { if (e.stage === "send_message") events.push(e.detail); });
  try {
    const result = await f.service.send(f.binding, { target, text: "定向消息", files: [{ path: "file.txt" }] }, { callId: "t" });
    const row = f.service.rows(f.ticket)[0]!, scope = target.slice(3);
    expect(`qq:${row.message_type}:${row.target_id}`).toBe(target); expect(row.mention_user_id).toBeNull();
    expect(f.history.message({ kind: "scope", scope }, result.message_id!)?.row).toMatchObject({ text: "定向消息", is_self: 1, reply_to_id: null });
    expect(f.history.message(f.binding.access, result.message_id!)).toBeNull();
    expect(f.call.mock.calls.at(-1)![0]).toBe(target.includes("group") ? "upload_group_file" : "upload_private_file");
    expect(events).toEqual([expect.objectContaining({ target })]);
  } finally { off(); }
});

it("默认回复与等于来源的 target 沿用 @ 规则，与主动发送同一回合不限条数", async () => {
  const f = await grantsFixture();
  await f.service.send(f.binding, { target: "qq:group:8", text: "先主动发" }, { callId: "1" });
  await f.service.send(f.binding, { target: "qq:group:7", text: "回复来源" }, { callId: "2" });
  await f.service.send(f.binding, { text: "补充" }, { callId: "3" });
  expect(f.service.rows(f.ticket).map(r => r.mention_user_id)).toEqual([null, null, null]);
  await f.service.send(f.binding, { target: "qq:private:9", text: "第四条" }, { callId: "4" });
  expect(f.service.rows(f.ticket).map(r => r.status)).toEqual(["sent", "sent", "sent", "sent"]);
});

it.each(["qq:group:0", "qq:private:01", "group:8", "other:group:8", "qq:group:8:1", "qq:group:8\n", 8])("非法 target %j 在建行前拒绝", async target => {
  const f = await grantsFixture();
  await expect(f.service.send(f.binding, { target, text: "拒绝" }, { callId: "x" })).rejects.toThrow("target");
  expect(f.service.rows(f.ticket)).toEqual([]); expect(f.listChats).not.toHaveBeenCalled();
});

it("非 owner 逐次检查 send 授权、目标和 scopes；到期及撤销立即失效", async () => {
  const f = await grantsFixture("99"), args = { text: "授权发送", target: "qq:group:8" };
  await expect(f.service.send(f.binding, args, { callId: "1" })).rejects.toThrow("授权");
  await f.grants.panel("auth_grant", { user: "qq:1", caps: ["send"], targets: [args.target], scopes: ["private:1"] });
  await expect(f.service.send(f.binding, args, { callId: "1" })).rejects.toThrow("授权");
  await f.grants.panel("auth_grant", { user: "qq:1", caps: ["send"], targets: [args.target], scopes: ["group:7"], expires_in_hours: 1 });
  await expect(f.service.send(f.binding, { ...args, target: "qq:private:9" }, { callId: "1" })).rejects.toThrow("授权");
  await f.service.send(f.binding, args, { callId: "1" });
  f.advance(3_600_000);
  await expect(f.service.send(f.binding, { ...args, text: "到期" }, { callId: "2" })).rejects.toThrow("授权");
  await f.grants.panel("auth_grant", { user: "qq:1", caps: ["send"], targets: [args.target] });
  await f.grants.panel("auth_revoke", { user: "qq:1" });
  await expect(f.service.send(f.binding, { ...args, text: "撤销" }, { callId: "2" })).rejects.toThrow("授权");
});

it("bot 必须在群内或与目标是好友；列表缓存五分钟，失败不缓存", async () => {
  const f = await grantsFixture();
  f.listChats.mockRejectedValueOnce(new Error("查询失败"));
  await expect(f.service.send(f.binding, { target: "qq:group:8", text: "失败" }, { callId: "1" })).rejects.toThrow("查询失败");
  await expect(f.service.send(f.binding, { target: "qq:group:99", text: "不在群" }, { callId: "1" })).rejects.toThrow("好友");
  await expect(f.service.send(f.binding, { target: "qq:private:99", text: "非好友" }, { callId: "1" })).rejects.toThrow("好友");
  await f.service.send(f.binding, { target: "qq:group:8", text: "有效" }, { callId: "1" });
  expect(f.listChats).toHaveBeenCalledTimes(2);
  f.advance(300_000);
  f.listChats.mockResolvedValue({ groups: [], friends: [] });
  await expect(f.service.send(f.binding, { target: "qq:group:8", text: "已退群" }, { callId: "2" })).rejects.toThrow("好友");
  expect(f.listChats).toHaveBeenCalledTimes(3);
});

it("相同正文不同目标分别发送；codex 重跑目标改变只返回原回执，不误重发", async () => {
  const f = await grantsFixture();
  const first = await f.service.send(f.binding, { target: "qq:group:8", text: "同文" }, { attempt: "a" });
  await f.service.send(f.binding, { target: "qq:private:9", text: "同文" }, { attempt: "a" });
  expect(await f.service.send(f.binding, { target: "qq:private:9", text: "同文" }, { attempt: "b" })).toMatchObject({ already_sent: true, message_id: first.message_id, target_id: "8" });
  expect(f.service.rows(f.ticket)).toHaveLength(2);
});

function seed(f: Awaited<ReturnType<typeof grantsFixture>>, n: number) {
  for (let i = 0; i < n; i++) f.store.reserveOutbox({ ticket: `quota_${i}`, proactive: true, call_id: null, text: "计数", images: [], files: [],
    message_type: "group", target_id: "8", mention_user_id: null });
}

it("每 ref 100 条限额包含模型 pending/uncertain 行，系统行排除；并发预留不能超限", async () => {
  const f = await grantsFixture(); seed(f, 99);
  for (const suffix of ["late", "fallback"] as const) f.store.reserveOutbox({ ticket: "system", suffix, call_id: null, text: "系统", images: [], files: [], message_type: "group", target_id: "8", mention_user_id: null });
  const second = { ...f.binding, ticket: f.store.createTicket({ ...f.msg, message_id: "12" }) };
  const results = await Promise.allSettled([f.binding, second].map((b, i) => f.service.send(b, { target: "qq:group:8", text: `第100条-${i}` }, { callId: "q" })));
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  await f.service.send(second, { target: "qq:private:9", text: "其他ref" }, { callId: "another" });
});

it("Asia/Shanghai 午夜重置；按目标 ref 的所有模型行计数，重放不新增计数", async () => {
  const f = await grantsFixture(); seed(f, 100);
  const db = new DatabaseSync(path.join(f.dir, "qq-bridge.sqlite"));
  try {
    db.prepare("UPDATE outbox SET created_at=?").run("2026-10-20T15:59:59.999Z");
    f.setNow(Date.parse("2026-10-20T15:59:59.999Z"));
    await expect(f.service.send(f.binding, { target: "qq:group:8", text: "超额" }, { callId: "x" })).rejects.toThrow("100 条");
    f.advance(1);
    await f.service.send(f.binding, { target: "qq:group:8", text: "新一天" }, { callId: "x" });
    expect(await f.service.send(f.binding, { target: "qq:group:8", text: "新一天" }, { callId: "x" })).toMatchObject({ already_sent: true });
    expect(f.service.rows(f.ticket)).toHaveLength(1);
  } finally { db.close(); }
});

it("非 owner 的同来源 target 不需要授权或好友查询，首条回复仍 @", async () => {
  const f = await grantsFixture("99");
  await f.service.send(f.binding, { target: "qq:group:7", text: "来源回复" }, { callId: "first" });
  expect(f.service.rows(f.ticket)[0]!.mention_user_id).toBe("1");
  expect(f.listChats).not.toHaveBeenCalled();
});

it("pending 跨目标消息重试不能绕过授权撤销或更换目标", async () => {
  const f = await grantsFixture("99");
  await f.grants.panel("auth_grant", { user: "qq:1", caps: ["send"], targets: ["qq:group:8"] });
  f.call.mockImplementationOnce(async () => ({ user_id: 99 }));
  await expect(f.service.send(f.binding, { target: "qq:group:8", text: "待重试" }, { callId: "x" })).rejects.toThrow("登录账号");
  await f.grants.panel("auth_revoke", { user: "qq:1" });
  await expect(f.service.send(f.binding, { target: "qq:group:8", text: "待重试" }, { callId: "x" })).rejects.toThrow("授权");
  const replay = await f.service.send(f.binding, { text: "改发来源" }, { callId: "x" });
  expect(replay).toMatchObject({ status: "pending", target_id: "8" });
  expect(f.service.rows(f.ticket)).toHaveLength(1);
  expect(f.call.mock.calls.filter(c => c[0].startsWith("send_"))).toHaveLength(0);
});


it.each(["pi", "codex"] as const)("已发送目标消息在授权撤销后仍可按 %s 调用身份重放", async backend => {
  const f = await grantsFixture("99");
  await f.grants.panel("auth_grant", { user: "qq:1", caps: ["send"], targets: ["qq:group:8"] });
  const args = { text: "已授权发送", target: "qq:group:8" };
  const first = await f.service.send(f.binding, args, backend === "pi" ? { callId: "stable" } : { attempt: "first" });
  await f.grants.panel("auth_revoke", { user: "qq:1" });
  const replay = await f.service.send(f.binding, args, backend === "pi" ? { callId: "stable" } : { attempt: "retry" });
  expect(replay).toMatchObject({ already_sent: true, message_id: first.message_id });
  expect(f.call.mock.calls.filter(([action]) => action === "send_group_msg")).toHaveLength(1);
  await expect(f.service.send(f.binding, { ...args, text: "新调用" }, { callId: "new" })).rejects.toThrow("授权");
});

it("普通来源回复不计每日主动额度，显式跨会话发送单独计数", async () => {
  const f = await grantsFixture();
  Object.assign(f.rules, { perChatMinute: 1000, perChatHour: 1000, globalMinute: 1000 });
  for (let i = 0; i < 100; i++) {
    const ticket = f.store.createTicket({ ...f.msg, group_id: "8", message_id: "reply-" + i });
    await f.service.send({ ...f.binding, ticket, source: { ...f.binding.source, group_id: "8" } },
      { text: "普通回复", ...(i % 2 ? { target: "qq:group:8" } : {}) }, { callId: "reply" });
    expect(f.service.rows(ticket)[0].proactive).toBe(false);
  }
  const count = () => f.store.countModelOutbox("group", "8", "2000", "2100");
  expect(count()).toBe(0);
  await f.service.send(f.binding, { text: "主动通知", target: "qq:group:8" }, { callId: "proactive" });
  expect(f.service.rows(f.ticket)[0].proactive).toBe(true);
  expect(count()).toBe(1);
});

it("即使 owner 有权且 bot 已入群，目标群也必须在 QQ_ALLOW_GROUPS 内", async () => {
  const f = await grantsFixture();
  f.listChats.mockResolvedValue({ groups: [{ group_id: "99", name: "未允许群" }], friends: [] });
  await expect(f.service.send(f.binding, { target: "qq:group:99", text: "拒绝" }, { callId: "denied" })).rejects.toThrow("QQ_ALLOW_GROUPS");
  expect(f.call.mock.calls.some(([action]) => action.startsWith("send_"))).toBe(false);
  expect(f.service.rows(f.ticket)[0].status).toBe("pending");
});

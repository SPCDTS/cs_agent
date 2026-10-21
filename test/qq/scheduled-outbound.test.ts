import { expect, it } from "vitest";
import { ReplyStore, isTicketId } from "../../src/qq/reply-store.js";
import { sendFixture } from "../agent/send-fixture.js";

const ticket = "run_" + "a".repeat(40);
const target = { origin: "scheduled" as const, message_type: "group" as const, target_id: "7", user_id: "1" };

it("出站票据与入站票据共享序列、幂等保存并能跨 ReplyStore 重开读取", async () => {
  const f = sendFixture();
  const first = await f.bridge.openOutbound(ticket, target);
  const next = f.store.createTicket({ ...f.msg, message_id: "12" });
  const again = await f.bridge.openOutbound(ticket, target);
  expect(first.seq).toBeGreaterThan(f.store.get(f.ticket)!.seq);
  expect(f.store.get(next)!.seq).toBeGreaterThan(first.seq);
  expect(again).toEqual(first);
  expect(f.store.listPending().map(rec => rec.ticket_id)).toEqual([f.ticket, ticket, next]);
  const reopened = new ReplyStore(f.dir);
  try {
    expect(reopened.get(ticket)).toEqual(first);
    expect(reopened.get(f.ticket)?.origin).toBe("message");
    expect(isTicketId(ticket)).toBe(true);
    expect(isTicketId("run_" + "a".repeat(39))).toBe(false);
  } finally { reopened.close(); }
});

it("重开相同票据不能更换目标或创建者，静默结算不可重置为 pending", async () => {
  const f = sendFixture();
  await f.bridge.openOutbound(ticket, target);
  await expect(f.bridge.openOutbound(ticket, { ...target, target_id: "8" })).rejects.toThrow("绑定不一致");
  await expect(f.bridge.openOutbound(ticket, { ...target, user_id: "9" })).rejects.toThrow("绑定不一致");
  await f.bridge.settleTicket(ticket);
  expect((await f.bridge.openOutbound(ticket, target)).status).toBe("sent");
  await expect(f.bridge.settleTicket(f.ticket)).rejects.toThrow("尚无消息发送");
});

it("Channel 对 scheduled 票据拒绝 @；登录身份检查仍生效", async () => {
  const f = sendFixture();
  await f.bridge.openOutbound(ticket, target);
  const row = f.store.reserveOutbox({ ticket, call_id: "at", text: "禁止 @", images: [], files: [],
    message_type: "group", target_id: "7", mention_user_id: "1" });
  await expect(f.bridge.send(row.key, row, row.text, [], { mention: "1" })).rejects.toThrow("定时或主动发送不能 @");
  expect(f.call.mock.calls.some(c => c[0].startsWith("send_"))).toBe(false);
  f.call.mockImplementation(async () => ({ user_id: 3 }));
  await expect(f.bridge.openOutbound(ticket, target)).rejects.toThrow("绑定不一致");
});

it("持久 Outbox 不再限制每轮条数，系统行不占模型序号", async () => {
  const f = sendFixture();
  await f.bridge.openOutbound(ticket, target);
  f.store.reserveOutbox({ ticket, suffix: "late", call_id: null, text: "系统", images: [], files: [],
    message_type: "group", target_id: "7", mention_user_id: null });
  for (let n = 1; n <= 6; n++) f.store.reserveOutbox({ ticket, call_id: `call-${n}`, text: `第${n}条`,
    images: [], files: [], message_type: "group", target_id: "7", mention_user_id: null });
  expect(f.store.listOutbox(ticket).map(row => row.key.slice(ticket.length))).toEqual(["#late", "#1", "#2", "#3", "#4", "#5", "#6"]);
});

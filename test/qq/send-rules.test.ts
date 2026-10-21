import { describe, expect, it, vi } from "vitest";
import { ReplyStore } from "../../src/qq/reply-store.js";
import { DEFAULT_SEND_RULES } from "../../src/channel/send-rules.js";
import { trace, Trace, type LiveEvent } from "../../src/shared/trace.js";
import { startAlerts } from "../../src/obs/alerts.js";
import { SettingsStore, settingsDefaults } from "../../src/agent/settings.js";
import { sendFixture } from "../agent/send-fixture.js";
import { tmp } from "../agent/helpers.js";
import { writeFileSync } from "node:fs";
import path from "node:path";

const T0 = Date.UTC(2026, 9, 21, 4, 0, 0);
const sends = (f: ReturnType<typeof sendFixture>) => f.call.mock.calls.filter(([action]) => action.startsWith("send_")).length;

/** 收集 bridge 记的发送规则事件。 */
function capture() {
  const events: LiveEvent[] = [];
  const off = trace.tap(e => { if (e.stage === "send_rejected" || e.stage === "send_breaker") events.push(e); });
  return { events, off, breakers: () => events.filter(e => e.stage === "send_breaker") };
}

/** 在同一会话另开一张入站票据，用于让计数跨回合累积。 */
function otherTicket(f: ReturnType<typeof sendFixture>, id: string, group = true) {
  const ticket = f.store.createTicket({ ...f.msg, message_id: id, ...(group ? {} : { message_type: "private" as const, group_id: null }) });
  return ticket;
}

describe("bridge 发送规则", () => {
  it("每会话每分钟第 7 条被拒，错误原样返回模型；被拒的尝试不计数，行保持 pending", async () => {
    const f = sendFixture();
    f.clock.now = T0;
    for (let n = 1; n <= 6; n++) await f.service.send(f.binding, { text: "第" + n + "条" }, { callId: "c" + n });
    const cap = capture();
    try {
      await expect(f.service.send(f.binding, { text: "第七条" }, { callId: "c7" }))
        .rejects.toThrow("发送过快：本会话每分钟最多 6 条，请稍后再发");
      expect(cap.events.map(e => [e.stage, e.status, e.scope, e.detail.rule])).toEqual([["send_rejected", "failed", "group:7", "chat_minute"]]);
    } finally { cap.off(); }
    expect(sends(f)).toBe(6);
    const rejected = f.service.rows(f.ticket).at(-1)!;
    expect(rejected).toMatchObject({ status: "pending", text: "第七条" });
    expect(rejected).not.toHaveProperty("rejected");
    // 被拒的那次若计数，放宽到 7 后仍会被拒。
    f.rules.perChatMinute = 7;
    await expect(f.service.send(f.binding, { text: "第七条" }, { callId: "c7" })).resolves.toMatchObject({ status: "sent" });
    expect(sends(f)).toBe(7);
    // 滑出一分钟窗口后恢复。
    f.rules.perChatMinute = 6;
    await expect(f.service.send(f.binding, { text: "第八条" }, { callId: "c8" })).rejects.toThrow("发送过快");
    f.clock.now = T0 + 60_001;
    await expect(f.service.send(f.binding, { text: "第八条" }, { callId: "c8" })).resolves.toMatchObject({ status: "sent" });
  });

  it("同一回合连发多条不再受每轮上限限制", async () => {
    const f = sendFixture(false);
    for (let n = 1; n <= 5; n++) await f.service.send(f.binding, { text: "消息" + n }, { callId: "m" + n });
    expect(f.service.rows(f.ticket).map(row => row.status)).toEqual(Array(5).fill("sent"));
  });

  it("每会话每小时超限熔断：拒绝、只通知一次、不影响其他会话、重开库仍生效、到期恢复", async () => {
    const f = sendFixture();
    Object.assign(f.rules, { perChatMinute: 100, perChatHour: 3, chatBreakerMinutes: 60 });
    f.clock.now = T0;
    const cap = capture();
    try {
      for (let n = 1; n <= 3; n++) { await f.service.send(f.binding, { text: "群" + n }, { callId: "g" + n }); f.clock.now += 1000; }
      await expect(f.service.send(f.binding, { text: "群4" }, { callId: "g4" }))
        .rejects.toThrow("发送过多：本会话每小时最多 3 条，已暂停本会话发送 60 分钟");
      await expect(f.service.send(f.binding, { text: "群5" }, { callId: "g5" })).rejects.toThrow("本会话发送已熔断");
      expect(cap.breakers()).toHaveLength(1);
      expect(cap.breakers()[0]!.detail).toMatchObject({ scope: "group:7", until: T0 + 3000 + 3_600_000, reason: "每小时超过 3 条" });
      // 其他会话不受影响（旧回复路径同样受规则约束）。
      const priv = otherTicket(f, "p1", false);
      await expect(f.bridge.reply(priv, "私聊照常")).resolves.toMatchObject({ already_sent: false });
    } finally { cap.off(); }
    const breakers = f.bridge.sendBreakers!();
    expect(breakers).toEqual([{ scope: "group:7", until: T0 + 3000 + 3_600_000, tripped_at: T0 + 3000, reason: "每小时超过 3 条" }]);
    const reopened = new ReplyStore(f.dir);
    try { expect(reopened.sendBreakers(T0 + 3000 + 3_599_000)).toEqual(breakers); } finally { reopened.close(); }
    f.clock.now = T0 + 3000 + 3_600_000;
    await expect(f.service.send(f.binding, { text: "群5" }, { callId: "g5" })).resolves.toMatchObject({ status: "sent" });
    expect(f.bridge.sendBreakers!()).toEqual([]);
  });

  it("熔断状态在新 ReplyStore / bridge 实例中仍拒绝发送", async () => {
    const f = sendFixture();
    Object.assign(f.rules, { perChatMinute: 100, perChatHour: 1 });
    f.clock.now = T0;
    await f.service.send(f.binding, { text: "一" }, { callId: "1" });
    await expect(f.service.send(f.binding, { text: "二" }, { callId: "2" })).rejects.toThrow("每小时最多 1 条");
    const store = new ReplyStore(f.dir);
    try {
      const row = store.reserveOutbox({ ticket: f.ticket, call_id: "x", text: "三", images: [], files: [],
        message_type: "group", target_id: "7", mention_user_id: null });
      expect(() => store.beginOutboxSend(row.key, { ...DEFAULT_SEND_RULES, perChatMinute: 100, perChatHour: 1 }, T0 + 1000)).toThrow("本会话发送已熔断");
      expect(store.getOutbox(row.key)!.status).toBe("pending");
    } finally { store.close(); }
  });

  it("全局每分钟超限熔断全部会话；sendOps 豁免且不计数；手动解除后从零计数", async () => {
    const f = sendFixture();
    Object.assign(f.rules, { globalMinute: 3, globalBreakerMinutes: 10 });
    f.clock.now = T0;
    for (let i = 0; i < 5; i++) await f.bridge.sendOps("private", "1", "告警" + i);
    const cap = capture();
    try {
      await f.service.send(f.binding, { text: "群一" }, { callId: "1" });
      await f.bridge.reply(otherTicket(f, "p1", false), "私聊一");
      await f.bridge.reply(otherTicket(f, "p2", false), "私聊二");
      await expect(f.bridge.reply(otherTicket(f, "p3", false), "私聊三"))
        .rejects.toThrow("全局发送过多：每分钟最多 3 条，已暂停全部发送 10 分钟");
      await expect(f.service.send(f.binding, { text: "群二" }, { callId: "2" })).rejects.toThrow("全部会话发送已熔断");
      expect(cap.breakers().map(e => e.detail.scope)).toEqual(["global"]);
      await expect(f.bridge.sendOps("private", "1", "熔断期间告警")).resolves.toMatchObject({ message_id: expect.any(String) });
    } finally { cap.off(); }
    expect(f.bridge.sendBreakers!().map(b => b.scope)).toEqual(["global"]);
    expect(f.bridge.resetSendBreaker!("group:7")).toBe(false);
    expect(f.bridge.resetSendBreaker!("global")).toBe(true);
    expect(f.bridge.sendBreakers!()).toEqual([]);
    // 解除前一分钟内的 3 条不再计入全局窗口。
    await f.service.send(f.binding, { text: "群二" }, { callId: "2" });
    await f.bridge.reply(otherTicket(f, "p4", false), "私聊四");
  });

  it("系统补发被规则拒绝时只告警不抛出，settle 仍能终结票据", async () => {
    const f = sendFixture();
    Object.assign(f.rules, { perChatMinute: 1 });
    f.clock.now = T0;
    await f.bridge.reply(otherTicket(f, "earlier"), "占满本分钟额度");
    await expect(f.service.system(f.ticket, "late", "迟到图片")).resolves.toMatchObject({ status: "pending", note: expect.stringContaining("发送过快") });
    await expect(f.service.system(f.ticket, "fallback", "兜底")).resolves.toMatchObject({ status: "pending" });
    await f.service.settle(f.ticket);
    expect((await f.bridge.getTicket(f.ticket))?.status).toBe("sent");
    expect(sends(f)).toBe(1);
  });

  it("模型消息被拒且没有系统补发时，票据仍不能静默结算", async () => {
    const f = sendFixture();
    Object.assign(f.rules, { perChatMinute: 1 });
    f.clock.now = T0;
    await f.bridge.reply(otherTicket(f, "earlier"), "占满本分钟额度");
    await expect(f.service.send(f.binding, { text: "被拒" }, { callId: "1" })).rejects.toThrow("发送过快");
    await expect(f.service.settle(f.ticket)).rejects.toThrow("尚无消息发送");
  });

  it("被拒的主动发送不占每日主动额度", async () => {
    const f = sendFixture();
    Object.assign(f.rules, { perChatMinute: 1 });
    f.clock.now = T0;
    const row = f.store.reserveOutbox({ ticket: f.ticket, call_id: "p", proactive: true, text: "主动", images: [], files: [],
      message_type: "group", target_id: "8", mention_user_id: null });
    expect(f.store.beginOutboxSend(row.key, f.rules, T0)).toBe(true);
    const second = f.store.reserveOutbox({ ticket: f.ticket, call_id: "q", proactive: true, text: "主动二", images: [], files: [],
      message_type: "group", target_id: "8", mention_user_id: null });
    expect(f.store.countModelOutbox("group", "8", "2000", "2100")).toBe(2);
    expect(() => f.store.beginOutboxSend(second.key, f.rules, T0)).toThrow("发送过快");
    expect(f.store.countModelOutbox("group", "8", "2000", "2100")).toBe(1);
    expect(f.store.markOutboxSending(second.key)).toBe(true);
    expect(f.store.countModelOutbox("group", "8", "2000", "2100")).toBe(2);
  });
});

describe("发送熔断告警", () => {
  it("每次熔断通知 owner 一次，不受告警开关与 30 分钟限频约束；拒绝事件本身不通知", () => {
    const send = vi.fn(async () => ({ message_id: "a" }));
    const t = new Trace({ append: e => ({ ...e, id: 1, detail_json: JSON.stringify(e.detail ?? {}) }) });
    const alerts = startAlerts({ enabled: () => false, owner: "1", trace: t,
      bridge: { status: () => ({ ws_connected: true, disconnect_count: 0, self_id: null, last_event_at: null }), sendOps: send } });
    try {
      t.event("x", "send_rejected", { status: "failed", detail: { rule: "chat_minute" } });
      expect(send).not.toHaveBeenCalled();
      t.event("x", "send_breaker", { detail: { scope: "group:7", until: T0 + 3_600_000, tripped_at: T0, reason: "每小时超过 60 条" } });
      t.event("y", "send_breaker", { detail: { scope: "global", until: T0 + 600_000, tripped_at: T0, reason: "全局每分钟超过 30 条" } });
      expect(send.mock.calls).toEqual([
        ["private", "1", "cs-agent 告警：会话 group:7发送熔断（每小时超过 60 条），暂停 60 分钟；可在面板设置页解除。"],
        ["private", "1", "cs-agent 告警：全部会话发送熔断（全局每分钟超过 30 条），暂停 10 分钟；可在面板设置页解除。"],
      ]);
    } finally { alerts.stop(); }
  });
});

describe("发送规则设置", () => {
  const cfg = { AGENT_BACKEND: "codex" as const, backendOverrides: {}, CODEX_REASONING_EFFORT: "high", ALERT_OWNER: false,
    CODEX_MODEL: "gpt-x", AGENT_MODEL_ID: "deepseek-flash", AGENT_THINKING_LEVEL: "low" as const };

  it("默认值、校验与旧文件缺项补默认", async () => {
    const dir = tmp("cs-send-rules-");
    const store = await SettingsStore.open(dir, settingsDefaults(cfg), new Trace());
    expect(store.current().sendRules).toEqual(DEFAULT_SEND_RULES);
    for (const bad of [{ perChatMinute: 0 }, { perChatHour: 1.5 }, { globalMinute: Number.NaN }, { chatBreakerMinutes: 1441 }, { extra: 1 }]) {
      await expect(store.update({ sendRules: { ...DEFAULT_SEND_RULES, ...bad } }, "test")).rejects.toThrow();
    }
    expect(store.current().sendRules).toEqual(DEFAULT_SEND_RULES);
    await store.update({ sendRules: { ...DEFAULT_SEND_RULES, perChatMinute: 10 } }, "test");
    expect((await SettingsStore.open(dir, settingsDefaults(cfg), new Trace())).current().sendRules.perChatMinute).toBe(10);
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ version: 1, settings: { alertOwner: true, sendRules: { globalMinute: 50 } } }));
    expect((await SettingsStore.open(dir, settingsDefaults(cfg), new Trace())).current())
      .toMatchObject({ alertOwner: true, sendRules: { ...DEFAULT_SEND_RULES, globalMinute: 50 } });
  });
});

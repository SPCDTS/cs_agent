import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync } from "node:fs";
import { ReplyStore } from "../../src/qq/reply-store.js";
import { createQQBridge } from "../../src/qq/bridge.js";
import { SendService, type SendBinding } from "../../src/agent/send-service.js";
import { ContextStore } from "../../src/context/store.js";
import type { InboundMessage } from "../../src/channel/types.js";
import { DEFAULT_SEND_RULES, type SendRuleLimits } from "../../src/channel/send-rules.js";
import { trace, Trace, type LiveEvent } from "../../src/shared/trace.js";
import { startAlerts } from "../../src/obs/alerts.js";
import { SettingsStore, settingsDefaults } from "../../src/agent/settings.js";
import { tmp } from "../agent/helpers.js";
import { writeFileSync } from "node:fs";
import path from "node:path";

const T0 = Date.UTC(2026, 9, 21, 4, 0, 0);
const clean: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of clean.splice(0).reverse()) await fn(); });

/** 群 7 的一条入站输入 + 会话绑定的发送服务；发送规则与时钟可在用例内就地修改。 */
function fixture(group = true) {
  const dir = tmp("cs-send-rules-"), workdir = path.join(dir, "work");
  mkdirSync(workdir);
  const store = new ReplyStore(dir), history = new ContextStore(dir);
  const msg: InboundMessage = { message_id: "11", message_type: group ? "group" : "private", group_id: group ? "7" : null,
    user_id: "1", self_id: "2", nickname: "问者", time: 1790000000, text: "你好", route_text: "你好", truncated: false,
    mentioned_self: group, images: [], segments: [] };
  const threadKey = group ? "group:7" : "private:1";
  const key = store.admit(msg, threadKey)!;
  let n = 0;
  const call = vi.fn(async (action: string, _params?: Record<string, unknown>) => {
    if (action === "get_login_info") return { user_id: 2 };
    if (action.startsWith("upload_")) return { file_id: "file-" + ++n };
    return { message_id: String(++n) };
  });
  const rules: SendRuleLimits = { ...DEFAULT_SEND_RULES };
  const clock: { now?: number } = {};
  const bridge = createQQBridge({ httpUrl: "http://unused.test", wsUrl: "ws://unused.test", token: "",
    allowUsers: ["1"], allowGroups: ["7", "8"], groupMentions: true, dataDir: dir, imageRoot: path.join(dir, "images"),
    sendRules: () => rules }, { client: { call }, now: () => clock.now ?? Date.now() });
  const service = new SendService({ getChannel: () => bridge, dataDir: dir, store: history });
  clean.push(() => { store.close(); history.close(); }, () => bridge.stop());
  const binding: SendBinding = { threadKey, turnId: "t1", identity: { kind: "user", sender: "1" }, scope: threadKey,
    inputKey: key, inputs: [key], workdir, access: { kind: "scope", scope: threadKey } };
  return { dir, store, msg, key, bridge, service, binding, call, rules, clock };
}
type Fixture = ReturnType<typeof fixture>;
const sends = (f: Fixture) => f.call.mock.calls.filter(([action]) => action.startsWith("send_")).length;
const rowOf = (f: Fixture, callKey: string) => f.store.getOutbox(`${f.binding.threadKey}:${callKey}`);

/** 收集 bridge 记的发送规则事件。 */
function capture() {
  const events: LiveEvent[] = [];
  const off = trace.tap(e => { if (e.stage === "send_rejected" || e.stage === "send_breaker") events.push(e); });
  return { events, off, breakers: () => events.filter(e => e.stage === "send_breaker") };
}

/** 另一条入站输入所在会话（默认私聊 1）经发送服务发一条，与 f.binding 的会话分开计数。 */
function otherSend(f: Fixture, id: string, text: string, group = false) {
  const m = { ...f.msg, message_id: id, ...(group ? {} : { message_type: "private" as const, group_id: null, mentioned_self: false }) };
  const threadKey = group ? "group:7" : "private:1";
  const key = f.store.admit(m, threadKey)!;
  return f.service.send({ ...f.binding, threadKey, scope: threadKey, inputKey: key, inputs: [key], access: { kind: "scope", scope: threadKey } }, { text }, id);
}

describe("bridge 发送规则", () => {
  it("每会话每分钟第 7 条被拒，错误原样返回模型；被拒的尝试不计数，行保持 pending", async () => {
    const f = fixture();
    f.clock.now = T0;
    for (let n = 1; n <= 6; n++) await f.service.send(f.binding, { text: "第" + n + "条" }, "c" + n);
    const cap = capture();
    try {
      await expect(f.service.send(f.binding, { text: "第七条" }, "c7"))
        .rejects.toThrow("发送过快：本会话每分钟最多 6 条，请稍后再发");
      expect(cap.events.map(e => [e.stage, e.status, e.scope, e.detail.rule])).toEqual([["send_rejected", "failed", "group:7", "chat_minute"]]);
    } finally { cap.off(); }
    expect(sends(f)).toBe(6);
    const rejected = rowOf(f, "c7")!;
    expect(rejected).toMatchObject({ status: "pending", text: "第七条" });
    expect(rejected).not.toHaveProperty("rejected");
    // 被拒的那次若计数，放宽到 7 后仍会被拒。
    f.rules.perChatMinute = 7;
    await expect(f.service.send(f.binding, { text: "第七条" }, "c7")).resolves.toMatchObject({ status: "sent" });
    expect(sends(f)).toBe(7);
    // 滑出一分钟窗口后恢复。
    f.rules.perChatMinute = 6;
    await expect(f.service.send(f.binding, { text: "第八条" }, "c8")).rejects.toThrow("发送过快");
    f.clock.now = T0 + 60_001;
    await expect(f.service.send(f.binding, { text: "第八条" }, "c8")).resolves.toMatchObject({ status: "sent" });
  });

  it("同一回合连发多条不受每轮上限限制", async () => {
    const f = fixture(false);
    for (let n = 1; n <= 5; n++) await f.service.send(f.binding, { text: "消息" + n }, "m" + n);
    expect(f.store.listOutboxByTurn("t1").map(row => row.status)).toEqual(Array(5).fill("sent"));
  });

  it("每会话每小时超限熔断：拒绝、只通知一次、不影响其他会话、重开库仍生效、到期恢复", async () => {
    const f = fixture();
    Object.assign(f.rules, { perChatMinute: 100, perChatHour: 3, chatBreakerMinutes: 60 });
    f.clock.now = T0;
    const cap = capture();
    try {
      for (let n = 1; n <= 3; n++) { await f.service.send(f.binding, { text: "群" + n }, "g" + n); f.clock.now += 1000; }
      await expect(f.service.send(f.binding, { text: "群4" }, "g4"))
        .rejects.toThrow("发送过多：本会话每小时最多 3 条，已暂停本会话发送 60 分钟");
      await expect(f.service.send(f.binding, { text: "群5" }, "g5")).rejects.toThrow("本会话发送已熔断");
      expect(cap.breakers()).toHaveLength(1);
      expect(cap.breakers()[0]!.detail).toMatchObject({ scope: "group:7", until: T0 + 3000 + 3_600_000, reason: "每小时超过 3 条" });
      // 其他会话不受影响。
      await expect(otherSend(f, "p1", "私聊照常")).resolves.toMatchObject({ status: "sent" });
    } finally { cap.off(); }
    const breakers = f.bridge.sendBreakers!();
    expect(breakers).toEqual([{ scope: "group:7", until: T0 + 3000 + 3_600_000, tripped_at: T0 + 3000, reason: "每小时超过 3 条" }]);
    const reopened = new ReplyStore(f.dir);
    try { expect(reopened.sendBreakers(T0 + 3000 + 3_599_000)).toEqual(breakers); } finally { reopened.close(); }
    f.clock.now = T0 + 3000 + 3_600_000;
    await expect(f.service.send(f.binding, { text: "群5" }, "g5")).resolves.toMatchObject({ status: "sent" });
    expect(f.bridge.sendBreakers!()).toEqual([]);
  });

  it("熔断状态在新 ReplyStore / bridge 实例中仍拒绝发送", async () => {
    const f = fixture();
    Object.assign(f.rules, { perChatMinute: 100, perChatHour: 1 });
    f.clock.now = T0;
    await f.service.send(f.binding, { text: "一" }, "1");
    await expect(f.service.send(f.binding, { text: "二" }, "2")).rejects.toThrow("每小时最多 1 条");
    const store = new ReplyStore(f.dir);
    try {
      const row = store.reserveOutbox({ key: "group:7:x", thread_key: "group:7", turn_id: null, input_key: null, text: "三", images: [], files: [],
        message_type: "group", target_id: "7", mention_user_id: null });
      expect(() => store.beginOutboxSend(row.key, { ...DEFAULT_SEND_RULES, perChatMinute: 100, perChatHour: 1 }, T0 + 1000)).toThrow("本会话发送已熔断");
      expect(store.getOutbox(row.key)!.status).toBe("pending");
    } finally { store.close(); }
  });

  it("全局每分钟超限熔断全部会话；sendOps 豁免且不计数；手动解除后从零计数", async () => {
    const f = fixture();
    Object.assign(f.rules, { globalMinute: 3, globalBreakerMinutes: 10 });
    f.clock.now = T0;
    for (let i = 0; i < 5; i++) await f.bridge.sendOps("private", "1", "告警" + i);
    const cap = capture();
    try {
      await f.service.send(f.binding, { text: "群一" }, "1");
      await otherSend(f, "p1", "私聊一");
      await otherSend(f, "p2", "私聊二");
      await expect(otherSend(f, "p3", "私聊三"))
        .rejects.toThrow("全局发送过多：每分钟最多 3 条，已暂停全部发送 10 分钟");
      await expect(f.service.send(f.binding, { text: "群二" }, "2")).rejects.toThrow("全部会话发送已熔断");
      expect(cap.breakers().map(e => e.detail.scope)).toEqual(["global"]);
      await expect(f.bridge.sendOps("private", "1", "熔断期间告警")).resolves.toMatchObject({ message_id: expect.any(String) });
    } finally { cap.off(); }
    expect(f.bridge.sendBreakers!().map(b => b.scope)).toEqual(["global"]);
    expect(f.bridge.resetSendBreaker!("group:7")).toBe(false);
    expect(f.bridge.resetSendBreaker!("global")).toBe(true);
    expect(f.bridge.sendBreakers!()).toEqual([]);
    // 解除前一分钟内的 3 条不再计入全局窗口。
    await f.service.send(f.binding, { text: "群二" }, "2");
    await otherSend(f, "p4", "私聊四");
  });

  it("系统消息被规则拒绝时只告警不抛出，行保持 pending 并记下原因", async () => {
    const f = fixture();
    Object.assign(f.rules, { perChatMinute: 1 });
    f.clock.now = T0;
    await otherSend(f, "earlier", "占满本分钟额度", true);
    await expect(f.service.system(f.binding, "出错提示")).resolves.toMatchObject({ status: "pending", note: expect.stringContaining("发送过快") });
    expect(sends(f)).toBe(1);
  });

  it("被拒的主动发送不占每日主动额度；系统行不计主动额度", async () => {
    const f = fixture();
    Object.assign(f.rules, { perChatMinute: 1 });
    f.clock.now = T0;
    const base = { thread_key: "group:7", turn_id: null, input_key: null, images: [], files: [], message_type: "group" as const, target_id: "8", mention_user_id: null };
    const row = f.store.reserveOutbox({ ...base, key: "group:7:p", proactive: true, text: "主动" });
    expect(f.store.beginOutboxSend(row.key, f.rules, T0)).toBe(true);
    const second = f.store.reserveOutbox({ ...base, key: "group:7:q", proactive: true, text: "主动二" });
    f.store.reserveOutbox({ ...base, key: "group:7:sys:x", proactive: true, system: true, text: "系统" });
    expect(f.store.countModelOutbox("group", "8", "2000", "2100")).toBe(2);
    expect(() => f.store.beginOutboxSend(second.key, f.rules, T0)).toThrow("发送过快");
    expect(f.store.countModelOutbox("group", "8", "2000", "2100")).toBe(1);
    expect(f.store.markOutboxSending(second.key)).toBe(true);
    expect(f.store.countModelOutbox("group", "8", "2000", "2100")).toBe(2);
  });

  it("模型 @ 仅限本轮发送者；系统通知可显式 @ 审批参与人", async () => {
    const f = fixture();
    const base = { thread_key: "group:7", turn_id: "t1", input_key: f.key, images: [], files: [], message_type: "group" as const, target_id: "7" };
    const proactive = f.store.reserveOutbox({ ...base, proactive: true, key: "group:7:a", text: "禁止 @", mention_user_id: "1" });
    await expect(f.bridge.send(proactive.key, proactive, proactive.text, [], { mention: "1" })).rejects.toThrow("定时或主动发送不能 @");
    const other = f.store.reserveOutbox({ ...base, key: "group:7:c", text: "@ 别人", mention_user_id: "9" });
    await expect(f.bridge.send(other.key, other, other.text, [], { mention: "9" })).rejects.toThrow("回复只能 @ 本轮发送者");
    const elsewhere = f.store.reserveOutbox({ ...base, key: "group:7:d", target_id: "8", text: "@ 外群", mention_user_id: "1" });
    await expect(f.bridge.send(elsewhere.key, elsewhere, elsewhere.text, [], { mention: "1" })).rejects.toThrow("回复只能 @ 本轮发送者");
    expect(sends(f)).toBe(0);
    const ok = f.store.reserveOutbox({ ...base, key: "group:7:e", text: "@ 提问者", mention_user_id: "1" });
    await expect(f.bridge.send(ok.key, ok, ok.text, [], { mention: "1" })).resolves.toMatchObject({ already_sent: false });
    const sent = f.call.mock.calls.find(c => c[0] === "send_group_msg")![1] as { message: { type: string; data: Record<string, unknown> }[] };
    expect(sent.message[0]).toEqual({ type: "at", data: { qq: "1" } });
    const system = f.store.reserveOutbox({ ...base, system: true, key: "group:7:sys:approval", text: "待审批", mention_user_id: "9" });
    await expect(f.bridge.send(system.key, system, system.text, [], { mention: "9" })).resolves.toMatchObject({ already_sent: false });
    const notice = f.call.mock.calls.filter(c => c[0] === "send_group_msg").at(-1)![1] as { message: { type: string; data: Record<string, unknown> }[] };
    expect(notice.message).toEqual(expect.arrayContaining([{ type: "at", data: { qq: "9" } }]));
  });

  it("登录账号与收到输入的账号不一致时拒绝发送，行保持 pending", async () => {
    const f = fixture();
    f.call.mockImplementation(async (action: string) => action === "get_login_info" ? { user_id: 3 } : { message_id: "x" });
    await expect(f.service.send(f.binding, { text: "换号了" }, "c1")).rejects.toThrow("登录账号");
    expect(rowOf(f, "c1")).toMatchObject({ status: "pending" });
    expect(sends(f)).toBe(0);
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

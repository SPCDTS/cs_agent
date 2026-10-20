import { FALLBACK_REPLY } from "../../src/agent/replies.js";
import { withOutbox } from "./outbox-stub.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { ObsStore } from "../../src/obs/store.js";
import { Trace, trace } from "../../src/shared/trace.js";
import { SettingsStore, SETTINGS_TICKET, settingsDefaults, type RuntimeSettings } from "../../src/agent/settings.js";
import { createBackendSelector } from "../../src/agent/backends/select.js";
import { CodexBackend } from "../../src/agent/backends/codex.js";
import type { AgentBackend, AgentRequest, BackendName } from "../../src/agent/backends/types.js";
import { createTasks } from "../../src/agent/tasks.js";
import { openHarness } from "../../src/agent/harness.js";
import { createCsAgentExtension } from "../../src/agent/extension.js";
import { TicketDoc, DispatchDoc } from "../../src/agent/docs.js";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Dispatcher } from "../../src/agent/dispatch.js";
import { startAlerts } from "../../src/obs/alerts.js";
import { log } from "../../src/shared/log.js";
import { loadAgentConfig as loadConfig } from "../../src/agent/config.js";
import type { InboundMessage, ReplyTicketRecord } from "../../src/channel/types.js";

const clean: (() => unknown)[] = [];
afterEach(async () => { trace.attach(undefined); for (const fn of clean.splice(0).reverse()) await fn(); });
const tmp = () => { const dir = mkdtempSync(path.join(os.tmpdir(), "cs-settings-")); clean.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const defaults: RuntimeSettings = { codexModel: "codex/gpt-6.1-sol", piModel: "deepseek-flash", piThinkingLevel: "low", agentBackend: "codex", backendOverrides: {}, codexReasoningEffort: "high", alertOwner: false };

describe("运行时设置", () => {
  it(".env 为默认；修改原子落盘并在重开后保留；记录 settings_changed 事件", async () => {
    const dir = tmp(); const store = new ObsStore(dir); clean.push(() => store.close());
    const t = new Trace(store);
    const s = await SettingsStore.open(dir, defaults, t);
    expect(s.current()).toEqual(defaults);
    const next = await s.update({ agentBackend: "pi", backendOverrides: { "group:7": "codex" }, alertOwner: true }, "dashboard");
    expect(next.agentBackend).toBe("pi");
    const file = JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8"));
    expect(file).toEqual({ version: 1, settings: { ...defaults, agentBackend: "pi", backendOverrides: { "group:7": "codex" }, alertOwner: true } });
    const reopened = await SettingsStore.open(dir, defaults, t);
    expect(reopened.current()).toMatchObject({ agentBackend: "pi", alertOwner: true, backendOverrides: { "group:7": "codex" } });
    const ev = store.events(SETTINGS_TICKET).find(e => e.stage === "settings_changed")!;
    const detail = JSON.parse(ev.detail_json);
    expect(detail).toMatchObject({ source: "dashboard", before: { agentBackend: "codex", alertOwner: false }, after: { agentBackend: "pi", alertOwner: true } });
    expect(detail.changed.sort()).toEqual(["agentBackend", "alertOwner", "backendOverrides"]);
    // 无变化不记事件；@ 票据不进票据列表
    await s.update({ agentBackend: "pi" }, "dashboard");
    expect(store.events(SETTINGS_TICKET).filter(e => e.stage === "settings_changed")).toHaveLength(1);
    expect(store.tickets().map(r => r.ticket)).not.toContain(SETTINGS_TICKET);
  });

  it("非法值被拒绝且不改动文件与当前值；损坏文件回退默认值", async () => {
    const dir = tmp();
    const s = await SettingsStore.open(dir, defaults, new Trace());
    await expect(s.update({ agentBackend: "gpt" as BackendName }, "test")).rejects.toThrow();
    await expect(s.update({ backendOverrides: { "evil": "pi" } }, "test")).rejects.toThrow();
    await expect(s.update({ codexReasoningEffort: "ultra" as never }, "test")).rejects.toThrow();
    expect(s.current()).toEqual(defaults);
    expect(() => readFileSync(path.join(dir, "settings.json"))).toThrow();
    writeFileSync(path.join(dir, "settings.json"), "{not json");
    expect((await SettingsStore.open(dir, defaults, new Trace())).current()).toEqual(defaults);
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ version: 1, settings: { agentBackend: "pi", extra: 1 } }));
    expect((await SettingsStore.open(dir, defaults, new Trace())).current()).toEqual(defaults);
  });

  it.each(["relay", "direct"])("旧 settings.json 的 codexReplyMode=%s 被剥离，其它设置完整保留且不告警", async mode => {
    const dir = tmp(), file = path.join(dir, "settings.json");
    const saved: RuntimeSettings = { ...defaults, agentBackend: "pi", backendOverrides: { "group:7": "codex" }, codexReasoningEffort: "low", alertOwner: true };
    writeFileSync(file, JSON.stringify({ version: 1, settings: { ...saved, codexReplyMode: mode } }), "utf8");
    const warn = vi.spyOn(log, "warn");
    try {
      const settings = await SettingsStore.open(dir, defaults, new Trace());
      expect(settings.current()).toEqual(saved);
      expect(warn).not.toHaveBeenCalled();
      await settings.update({ codexReasoningEffort: "medium" }, "test");
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, settings: { ...saved, codexReasoningEffort: "medium" } });
      expect((await SettingsStore.open(dir, defaults, new Trace())).current()).toEqual({ ...saved, codexReasoningEffort: "medium" });
    } finally { warn.mockRestore(); }
  });

  it("settingsDefaults 取自 .env；不在允许列表的推理强度回落 high", () => {
    const cfg = loadConfig({ AGENT_BACKEND: "pi", AGENT_BACKEND_OVERRIDES: "group:1=codex", CODEX_REASONING_EFFORT: "medium", ALERT_OWNER: "true" });
    expect(settingsDefaults(cfg)).toEqual({ ...defaults, agentBackend: "pi", backendOverrides: { "group:1": "codex" }, codexReasoningEffort: "medium", alertOwner: true });
    expect(settingsDefaults({ ...cfg, CODEX_REASONING_EFFORT: "bogus" }).codexReasoningEffort).toBe("high");
  });

  it("派发器无需重启即按新设置选择后端；推理强度与告警开关同样现读", async () => {
    const dir = tmp();
    const settings = await SettingsStore.open(dir, defaults, new Trace());
    const calls: { backend: string; ticket: string; effort?: string }[] = [];
    const fake = (name: BackendName): AgentBackend => ({ name, handle: async (req: AgentRequest) => { calls.push({ backend: name, ticket: req.ticket }); return { text: `来自 ${name}` }; } });
    const efforts: (string | undefined)[] = [];
    const codex = new CodexBackend({ runner: { ask: async (_p, o) => { efforts.push(o?.reasoningEffort); await o?.onAcquired?.(); return "codex 回答"; } },
      imagesDir: path.join(dir, "images"), ticketsDir: path.join(dir, "tickets"), reasoningEffort: () => settings.current().codexReasoningEffort });
    const states = new Map<string, string>();
    const replies: string[] = [];
    const bridge = {
      uploadFile: async () => ({ file_id: "unused" }),
      getTicket: async (ticket: string) => ({ ticket_id: ticket, seq: 1, status: states.get(ticket) ?? "pending" }) as ReplyTicketRecord,
      listPendingTickets: async () => [],
      reply: async (ticket: string, text: string) => { states.set(ticket, "sent"); replies.push(text); return { message_id: "r-" + ticket, already_sent: false, message_type: "private" as const, target_id: "1" }; },
    };
    const image = { name: "fake", submit: async () => "p", collect: async () => [], reconcile: async () => ({ images: [] as string[] }), clearReferences: async () => {} };
    const tasks = createTasks({ getBridge: () => withOutbox(bridge), imageBackend: image, imagesDir: path.join(dir, "images"), ticketsDir: path.join(dir, "tickets"),
      backends: createBackendSelector({ current: () => settings.current(), backends: { codex, pi: fake("pi") } }),
      currentSettings: () => settings.current(),
      replyRetryDelayMs: 1 });
    const harness = await openHarness({ models: createModels(), extension: createCsAgentExtension(tasks), dbFile: path.join(dir, "agent.sqlite") }, BACKGROUND_CONTEXT);
    clean.push(() => harness.close(BACKGROUND_CONTEXT));
    harness.resume();
    const dispatcher = new Dispatcher({ harness, bridge, tasks, concurrency: 1, retryDelayMs: 1 });
    const msg = (text: string, group?: string): InboundMessage => ({ message_id: text, time: Math.floor(Date.now() / 1000), message_type: group ? "group" : "private",
      user_id: "1", group_id: group ?? null, self_id: "2", nickname: "测试", text, route_text: text, images: [], segments: [], truncated: false, mentioned_self: true });

    await dispatcher.dispatch(msg("一"), "t1");
    await settings.update({ agentBackend: "pi" }, "test");
    await dispatcher.dispatch(msg("二"), "t2");
    await settings.update({ backendOverrides: { "group:9": "codex" }, codexReasoningEffort: "low" }, "test");
    await dispatcher.dispatch(msg("三", "9"), "t3");
    await dispatcher.dispatch(msg("四", "8"), "t4");
    expect(calls.map(c => `${c.ticket}:${c.backend}`)).toEqual(["t2:pi", "t4:pi"]);
    expect(efforts).toEqual(["high", "low"]);
    expect(replies).toEqual(Array(4).fill(FALLBACK_REPLY));

    vi.useFakeTimers();
    try {
      const send = vi.fn(async () => ({ message_id: "a" }));
      const t = new Trace({ append: e => ({ ...e, id: 1, detail_json: JSON.stringify(e.detail ?? {}) }) });
      const alerts = startAlerts({ enabled: () => settings.current().alertOwner, owner: "1", trace: t,
        bridge: { status: () => ({ ws_connected: true, disconnect_count: 0, self_id: null, last_event_at: null }), sendOps: send } });
      const fail = (n: number) => { for (let i = 0; i < 3; i++) t.event(`f${n}-${i}`, "failed", { detail: { terminal: true } }); };
      fail(1); expect(send).not.toHaveBeenCalled();
      await settings.update({ alertOwner: true }, "test");
      fail(2); expect(send).toHaveBeenCalledTimes(1);
      alerts.stop();
    } finally { vi.useRealTimers(); }
  });
});


describe("票据设置快照", () => {
  it.each([false, true])("回合中热更新仍保留 high，后续票据使用 low；恢复=%s", async recovery => {
    const dir = tmp();
    const settings = await SettingsStore.open(dir, defaults, new Trace());
    const obs = new ObsStore(dir); clean.push(() => obs.close()); trace.attach(obs);
    const models = createModels();
    const replies = new Map<string, string>();
    const bridge = {
      uploadFile: async () => ({ file_id: "unused" }),
      getTicket: async (ticket: string) => ({ ticket_id: ticket, seq: 1, status: replies.has(ticket) ? "sent" : "pending" }) as ReplyTicketRecord,
      listPendingTickets: async () => [],
      reply: async (ticket: string, text: string) => { replies.set(ticket, text); return { message_id: ticket, already_sent: false, message_type: "private" as const, target_id: "1" }; },
    };
    const history = { recordPending: vi.fn(), completeReply: vi.fn() };
    const efforts: (string | undefined)[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const current = vi.fn(() => settings.current());
    const boot = async (block: boolean) => {
      const codex = new CodexBackend({ imagesDir: path.join(dir, "images"), ticketsDir: path.join(dir, "tickets"),
        reasoningEffort: "low",
        runner: { ask: async (_prompt, options) => {
          efforts.push(options?.reasoningEffort); await options?.onAcquired?.();
          if (block) await Promise.race([gate, new Promise<never>((_, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("shutdown")), { once: true }))]);
          return "原始回答";
        } },
      });
      const tasks = createTasks({ getBridge: () => withOutbox(bridge),
        imageBackend: { name: "fake", submit: async () => "p", collect: async () => [], reconcile: async () => ({ images: [] }), clearReferences: async () => {} },
        imagesDir: path.join(dir, "images"), ticketsDir: path.join(dir, "tickets"),
        backends: createBackendSelector({ current, backends: { codex } }), currentSettings: current,
      });
      const harness = await openHarness({ models, extension: createCsAgentExtension(tasks), dbFile: path.join(dir, "tickets.sqlite") }, BACKGROUND_CONTEXT);
      clean.push(() => harness.close(BACKGROUND_CONTEXT));
      return { harness, dispatcher: new Dispatcher({ harness, bridge, tasks, history, concurrency: 1, retryDelayMs: 1 }) };
    };
    let first = await boot(true);
    const msg: InboundMessage = { message_id: "m", time: 1, message_type: "private", user_id: "1", group_id: null, self_id: "2", nickname: "测试", text: "你好", route_text: "你好", images: [], segments: [], truncated: false, mentioned_self: true };
    first.harness.resume();
    const pending = first.dispatcher.dispatch(msg, "first");
    await vi.waitFor(() => expect(efforts).toEqual(["high"]));
    const id = (await first.harness.snapshot(DispatchDoc, BACKGROUND_CONTEXT))!.pending.first!.conversationId as ConversationId;
    expect((await first.harness.snapshot(TicketDoc, id, BACKGROUND_CONTEXT))?.settings).toEqual({ backend: "codex", codexReasoningEffort: "high", codexModel: defaults.codexModel, piModel: defaults.piModel, piThinkingLevel: "low", effortSource: "fixed" });
    // 已排队票据也应冻结；当前回合结束前改设置。
    const queued = recovery ? undefined : first.dispatcher.dispatch(msg, "queued");
    await settings.update({ codexReasoningEffort: "low", agentBackend: "pi" }, "test");
    current.mockImplementation(() => { throw new Error("执行及恢复不得读取当前设置"); });
    if (recovery) {
      await first.harness.close(BACKGROUND_CONTEXT); await pending;
      first = await boot(false);
      await first.dispatcher.recover(); first.harness.resume(); await first.dispatcher.idle();
    } else { release(); await pending; await queued; }
    expect(replies.get("first")).toBe(FALLBACK_REPLY);
    expect(history.completeReply).not.toHaveBeenCalled();
    expect(efforts.every(e => e === "high")).toBe(true);
    if (!recovery) expect(replies.get("queued")).toBe(FALLBACK_REPLY);
    expect(obs.events("first").some(e => e.stage === "final_answer" && JSON.parse(e.detail_json).text === "原始回答")).toBe(true);
    await settings.update({ agentBackend: "codex" }, "test"); current.mockImplementation(() => settings.current());
    await first.dispatcher.dispatch(msg, "next");
    expect(efforts.at(-1)).toBe("low"); expect(replies.get("next")).toBe(FALLBACK_REPLY);
    expect(history.completeReply).not.toHaveBeenCalled();
    expect(obs.events("next").some(e => e.stage === "final_answer" && JSON.parse(e.detail_json).text === "原始回答")).toBe(true);
  });
});

describe("auto 派发集成", () => {
  it.each(["high", "invalid"])("派发等待分类 %s，票据落具体档位并传给 runner", async output => {
    const dir = tmp(), settings = await SettingsStore.open(dir, { ...defaults, codexReasoningEffort: "auto" });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    clean.push(() => release());
    const complete = vi.fn(async () => output), ask = vi.fn(async (_prompt: string, options: import("../../src/agent/codex/runner.js").AskOptions) => {
      await options.onAcquired?.(); await gate; return "已完成";
    });
    const codex = new CodexBackend({ runner: { ask }, imagesDir: path.join(dir, "images"), ticketsDir: path.join(dir, "tickets") });
    const sent = new Set<string>();
    const bridge = { uploadFile: vi.fn(), listPendingTickets: async () => [],
      getTicket: async (ticket: string) => ({ ticket_id: ticket, seq: 1, status: sent.has(ticket) ? "sent" : "pending" }) as ReplyTicketRecord,
      reply: async (ticket: string) => { sent.add(ticket); return { message_id: ticket, already_sent: false, message_type: "private" as const, target_id: "1" }; },
    };
    const tasks = createTasks({ currentSettings: () => settings.current(), codexReasoningEffort: "medium", effortRouter: { complete },
      getBridge: () => withOutbox(bridge), imagesDir: path.join(dir, "images"),
      imageBackend: { name: "fake", submit: vi.fn(), collect: vi.fn(), reconcile: vi.fn(), clearReferences: vi.fn() },
      backends: createBackendSelector({ current: () => settings.current(), backends: { codex } }),
    });
    const harness = await openHarness({ models: createModels(), extension: createCsAgentExtension(tasks), dbFile: path.join(dir, "auto.sqlite") }, BACKGROUND_CONTEXT);
    clean.push(() => harness.close(BACKGROUND_CONTEXT));
    const dispatcher = new Dispatcher({ harness, bridge, tasks, concurrency: 1 });
    const msg: InboundMessage = { message_id: "auto", time: 1, message_type: "private", user_id: "1", group_id: null, self_id: "2", nickname: "测试",
      text: "看看", route_text: "看看", images: [], segments: [{ type: "reply", data: { id: "quoted" } }], truncated: false, mentioned_self: true };
    const pending = dispatcher.dispatch(msg, "auto-ticket");
    await vi.waitFor(async () => expect((await harness.snapshot(DispatchDoc, BACKGROUND_CONTEXT))?.pending["auto-ticket"]).toBeDefined());
    const id = (await harness.snapshot(DispatchDoc, BACKGROUND_CONTEXT))!.pending["auto-ticket"]!.conversationId as ConversationId;
    const effort = output === "high" ? "high" : "medium";
    expect((await harness.snapshot(TicketDoc, id, BACKGROUND_CONTEXT))?.settings).toMatchObject({ codexModel: defaults.codexModel,
      codexReasoningEffort: effort, effortSource: output === "high" ? "auto" : "auto-fallback" });
    expect(complete).toHaveBeenCalledTimes(1); expect(complete.mock.calls[0]?.length).toBe(2);
    await settings.update({ codexModel: "changed-after-dispatch", codexReasoningEffort: "low" }, "test");
    release(); await pending;
    expect(ask).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ model: defaults.codexModel, reasoningEffort: effort }));
  });
});

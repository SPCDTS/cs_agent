import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { ObsStore } from "../../src/obs/store.js";
import { Trace, trace } from "../../src/obs/trace.js";
import { SettingsStore, SETTINGS_TICKET, settingsDefaults, type RuntimeSettings } from "../../src/agent/settings.js";
import { createBackendSelector } from "../../src/agent/backends/select.js";
import { CodexBackend } from "../../src/agent/backends/codex.js";
import type { AgentBackend, AgentRequest, BackendName } from "../../src/agent/backends/types.js";
import { createTasks } from "../../src/agent/tasks.js";
import { openHarness } from "../../src/agent/harness.js";
import { createCsAgentExtension } from "../../src/agent/extension.js";
import { Dispatcher } from "../../src/agent/dispatch.js";
import { startAlerts } from "../../src/obs/alerts.js";
import { loadConfig } from "../../src/config.js";
import type { InboundMessage, ReplyTicketRecord } from "../../src/qq/types.js";

const clean: (() => unknown)[] = [];
afterEach(async () => { trace.attach(undefined); for (const fn of clean.splice(0).reverse()) await fn(); });
const tmp = () => { const dir = mkdtempSync(path.join(os.tmpdir(), "cs-settings-")); clean.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const defaults: RuntimeSettings = { agentBackend: "codex", backendOverrides: {}, codexReplyMode: "relay", codexReasoningEffort: "high", alertOwner: false };

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
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ version: 1, settings: { codexReplyMode: "direct" } }));
    expect((await SettingsStore.open(dir, defaults, new Trace())).current()).toEqual({ ...defaults, codexReplyMode: "direct" });
  });

  it("settingsDefaults 取自 .env；不在允许列表的推理强度回落 high", () => {
    const cfg = loadConfig({ AGENT_BACKEND: "pi", AGENT_BACKEND_OVERRIDES: "group:1=codex", CODEX_REPLY_MODE: "direct", CODEX_REASONING_EFFORT: "medium", ALERT_OWNER: "true" });
    expect(settingsDefaults(cfg)).toEqual({ agentBackend: "pi", backendOverrides: { "group:1": "codex" }, codexReplyMode: "direct", codexReasoningEffort: "medium", alertOwner: true });
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
      getTicket: async (ticket: string) => ({ ticket_id: ticket, seq: 1, status: states.get(ticket) ?? "pending" }) as ReplyTicketRecord,
      listPendingTickets: async () => [],
      reply: async (ticket: string, text: string) => { states.set(ticket, "sent"); replies.push(text); return { message_id: "r-" + ticket, already_sent: false, message_type: "private" as const, target_id: "1" }; },
    };
    const image = { name: "fake", submit: async () => "p", collect: async () => [], reconcile: async () => ({ images: [] as string[] }), clearReferences: async () => {} };
    const tasks = createTasks({ getBridge: () => bridge, imageBackend: image, imagesDir: path.join(dir, "images"), ticketsDir: path.join(dir, "tickets"),
      backends: createBackendSelector({ current: () => settings.current(), backends: { codex, pi: fake("pi") } }),
      codexReplyMode: () => settings.current().codexReplyMode, replyRetryDelayMs: 1 });
    const harness = await openHarness({ models: createModels(), extension: createCsAgentExtension(tasks), dbFile: path.join(dir, "agent.sqlite") }, BACKGROUND_CONTEXT);
    clean.push(() => harness.close(BACKGROUND_CONTEXT));
    harness.resume();
    const dispatcher = new Dispatcher({ harness, bridge, tasks, concurrency: 1, retryDelayMs: 1 });
    const msg = (text: string, group?: string): InboundMessage => ({ message_id: text, time: Math.floor(Date.now() / 1000), message_type: group ? "group" : "private",
      user_id: "1", group_id: group ?? null, self_id: "2", nickname: "测试", text, route_text: text, images: [], segments: [], truncated: false, mentioned_self: true });

    await settings.update({ codexReplyMode: "direct" }, "test");
    await dispatcher.dispatch(msg("一"), "t1");
    await settings.update({ agentBackend: "pi" }, "test");
    await dispatcher.dispatch(msg("二"), "t2");
    await settings.update({ backendOverrides: { "group:9": "codex" }, codexReasoningEffort: "low" }, "test");
    await dispatcher.dispatch(msg("三", "9"), "t3");
    await dispatcher.dispatch(msg("四", "8"), "t4");
    expect(calls.map(c => `${c.ticket}:${c.backend}`)).toEqual(["t2:pi", "t4:pi"]);
    expect(efforts).toEqual(["high", "low"]);
    expect(replies).toEqual(["codex 回答", "来自 pi", "codex 回答", "来自 pi"]);

    vi.useFakeTimers();
    try {
      const send = vi.fn(async () => ({ message_id: "a" }));
      const t = new Trace({ append: e => ({ ...e, id: 1, detail_json: JSON.stringify(e.detail ?? {}) }) });
      const alerts = startAlerts({ enabled: () => settings.current().alertOwner, owner: "1", trace: t,
        bridge: { status: () => ({ ws_connected: true, disconnect_count: 0, self_id: null, last_event_at: null }), send } });
      const fail = (n: number) => { for (let i = 0; i < 3; i++) t.event(`f${n}-${i}`, "failed", { detail: { terminal: true } }); };
      fail(1); expect(send).not.toHaveBeenCalled();
      await settings.update({ alertOwner: true }, "test");
      fail(2); expect(send).toHaveBeenCalledTimes(1);
      alerts.stop();
    } finally { vi.useRealTimers(); }
  });
});

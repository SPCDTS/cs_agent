import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObsStore } from "../../src/obs/store.js";
import { Trace, trace } from "../../src/shared/trace.js";
import { SettingsStore, SETTINGS_KEY, historyRawDays, memoryConsolidateEnabled, memoryExtractEnabled, normalizeHistoryRawDays, settingsDefaults, type RuntimeSettings } from "../../src/agent/settings.js";
import { DEFAULT_SEND_RULES } from "../../src/channel/send-rules.js";
import { CodexBackend } from "../../src/agent/backends/codex.js";
import type { BackendName, SettingsSnapshot } from "../../src/agent/backends/types.js";
import { BackendRouter, type BackendAdapter } from "../../src/agent/turns.js";
import { createTurnSettings } from "../../src/agent/turn-settings.js";
import type { InputRef, ThreadKey } from "../../src/agent/host/types.js";
import { startAlerts } from "../../src/obs/alerts.js";
import { log } from "../../src/shared/log.js";
import { loadAgentConfig as loadConfig } from "../../src/agent/config.js";
import type { InboundRecord } from "../../src/channel/types.js";
import { CodexScript, codexRunnerRig } from "./codex-fixture.js";

/** 常驻 codex 适配器（内存版 app-server）：script 记录每轮 turn/start 的推理强度与模型。 */
async function codexBackend(dir: string, script: CodexScript, turns: ConstructorParameters<typeof CodexBackend>[0]["turns"], reasoningEffort?: string) {
  const r = await codexRunnerRig({ dir, handlers: script.handlers });
  clean.push(() => r.close());
  return new CodexBackend({ runner: r.runner, tokens: { issue: () => "a".repeat(64), revoke: () => undefined }, imagesDir: path.join(dir, "images"), turns,
    ...(reasoningEffort ? { reasoningEffort } : {}) });
}

const clean: (() => unknown)[] = [];
afterEach(async () => { trace.attach(undefined); for (const fn of clean.splice(0).reverse()) await fn(); });
const tmp = () => { const dir = mkdtempSync(path.join(os.tmpdir(), "cs-settings-")); clean.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const defaults: RuntimeSettings = { codexModel: "codex/gpt-6.1-sol", piModel: "deepseek-flash", piThinkingLevel: "low", agentBackend: "codex", backendOverrides: {}, codexReasoningEffort: "high", alertOwner: false, sendRules: { ...DEFAULT_SEND_RULES }, memory: { extract: {}, consolidate: true }, history: { rawDays: {} } };

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
    const ev = store.events(SETTINGS_KEY).find(e => e.stage === "settings_changed")!;
    const detail = JSON.parse(ev.detail_json);
    expect(detail).toMatchObject({ source: "dashboard", before: { agentBackend: "codex", alertOwner: false }, after: { agentBackend: "pi", alertOwner: true } });
    expect(detail.changed.sort()).toEqual(["agentBackend", "alertOwner", "backendOverrides"]);
    // 无变化不记事件；@ 票据不进票据列表
    await s.update({ agentBackend: "pi" }, "dashboard");
    expect(store.events(SETTINGS_KEY).filter(e => e.stage === "settings_changed")).toHaveLength(1);
    expect(store.turns().map(r => r.key)).not.toContain(SETTINGS_KEY);
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

  it("记忆抽取开关：缺省只有 owner 开启；旧文件缺 memory 时补默认，已保存的键与默认合并；命名空间须合法", async () => {
    const dir = tmp(), file = path.join(dir, "settings.json");
    expect(memoryExtractEnabled(defaults, "owner")).toBe(true);
    expect(memoryExtractEnabled(defaults, "group:7")).toBe(false);
    expect(memoryExtractEnabled(defaults, "private:5")).toBe(false);
    writeFileSync(file, JSON.stringify({ version: 1, settings: { agentBackend: "pi" } }), "utf8");
    expect((await SettingsStore.open(dir, defaults, new Trace())).current().memory).toEqual({ extract: {}, consolidate: true });
    writeFileSync(file, JSON.stringify({ version: 1, settings: { memory: { extract: { "group:7": true } } } }), "utf8");
    const s = await SettingsStore.open(dir, defaults, new Trace());
    expect(s.current().memory.extract).toEqual({ "group:7": true });
    expect(memoryExtractEnabled(s.current(), "group:7")).toBe(true);
    await s.update({ memory: { extract: { owner: false, "group:7": true } } }, "test");
    expect(memoryExtractEnabled(s.current(), "owner")).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8")).settings.memory).toEqual({ extract: { owner: false, "group:7": true }, consolidate: true });
    await expect(s.update({ memory: { extract: { "group:abc": true } } }, "test")).rejects.toThrow();
    // 与缺省相同的键（owner 开、其余关）不保存：几个关闭的会话加 owner 关闭，只剩 { owner: false }
    await s.update({ memory: { extract: { "group:7": false, "group:8": false, "private:5": false, owner: false } } }, "test");
    expect(s.current().memory.extract).toEqual({ owner: false });
    await s.update({ memory: { extract: { owner: true } } }, "test");
    expect(s.current().memory.extract).toEqual({});
    expect(memoryExtractEnabled(s.current(), "owner")).toBe(true);
    await expect(s.update({ memory: { extract: { owner: true }, other: true } as never }, "test")).rejects.toThrow();
    expect(() => { (s.current().memory.extract as Record<string, boolean>).owner = true; }).toThrow();
  });

  it("记忆整理开关：缺省开；只改 consolidate 不动抽取开关，只改抽取开关不把整理复位；旧文件缺键补缺省；非布尔拒绝", async () => {
    const dir = tmp(), file = path.join(dir, "settings.json");
    expect(memoryConsolidateEnabled(defaults)).toBe(true);
    writeFileSync(file, JSON.stringify({ version: 1, settings: { memory: { extract: { "group:7": true } } } }), "utf8");
    const s = await SettingsStore.open(dir, defaults, new Trace());
    expect(s.current().memory).toEqual({ extract: { "group:7": true }, consolidate: true });
    await s.update({ memory: { consolidate: false } }, "test");
    expect(memoryConsolidateEnabled(s.current())).toBe(false);
    expect(s.current().memory.extract).toEqual({ "group:7": true });
    await s.update({ memory: { extract: {} } }, "test");
    expect(s.current().memory).toEqual({ extract: {}, consolidate: false });
    expect(JSON.parse(readFileSync(file, "utf8")).settings.memory).toEqual({ extract: {}, consolidate: false });
    expect((await SettingsStore.open(dir, defaults, new Trace())).current().memory.consolidate).toBe(false);
    await expect(s.update({ memory: { consolidate: "yes" } as never }, "test")).rejects.toThrow();
  });

  it("聊天记录保留期：缺省没有覆盖；旧文件缺 history 时补空表，已保存的键与默认合并；只保存与全局缺省不同的天数；owner 键作用于 owner 私聊", async () => {
    const dir = tmp(), file = path.join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({ version: 1, settings: { agentBackend: "pi" } }), "utf8");
    expect((await SettingsStore.open(dir, defaults, new Trace())).current().history).toEqual({ rawDays: {} });
    writeFileSync(file, JSON.stringify({ version: 1, settings: { history: { rawDays: { "group:7": 0 } } } }), "utf8");
    const s = await SettingsStore.open(dir, defaults, new Trace());
    expect(historyRawDays(s.current(), "group:7", 30, ["1"])).toBe(0);
    expect(historyRawDays(s.current(), "group:8", 30, ["1"])).toBe(30);
    // 面板提交全部会话：与全局缺省 30 相同的不保存
    await s.update({ history: { rawDays: normalizeHistoryRawDays({ "group:7": 0, "group:8": 30, owner: 365 }, 30) as Record<string, number> } }, "test");
    expect(JSON.parse(readFileSync(file, "utf8")).settings.history).toEqual({ rawDays: { "group:7": 0, owner: 365 } });
    expect(historyRawDays(s.current(), "private:1", 30, ["1"])).toBe(365);
    expect(historyRawDays(s.current(), "private:2", 30, ["1"])).toBe(30);
    await expect(s.update({ history: { rawDays: { "group:7": 3651 } } }, "test")).rejects.toThrow();
  });

  it("settingsDefaults 取自 .env；不在允许列表的推理强度回落 high", () => {
    const cfg = loadConfig({ AGENT_BACKEND: "pi", AGENT_BACKEND_OVERRIDES: "group:1=codex", CODEX_REASONING_EFFORT: "medium", ALERT_OWNER: "true" });
    expect(settingsDefaults(cfg)).toEqual({ ...defaults, agentBackend: "pi", backendOverrides: { "group:1": "codex" }, codexReasoningEffort: "medium", alertOwner: true });
    expect(settingsDefaults({ ...cfg, CODEX_REASONING_EFFORT: "bogus" }).codexReasoningEffort).toBe("high");
  });

  it("路由器无需重启即按新设置选择后端；推理强度与告警开关同样现读", async () => {
    const dir = tmp();
    const settings = await SettingsStore.open(dir, defaults, new Trace());
    const calls: string[] = [];
    const fake = (name: BackendName): BackendAdapter => ({
      startTurn: async (_threadKey, inputs, _ctx, snapshot) => { calls.push(`${inputs[0]!.inboundKey}:${name}:${snapshot?.codexReasoningEffort}`); return { turnId: `${name}:${inputs[0]!.inboundKey}` }; },
      steer: async () => "no_active_turn", interrupt: async () => {}, recoverTurn: async () => "lost",
    });
    const records = new Map<string, InboundRecord>();
    const router = new BackendRouter({ backends: { codex: fake("codex"), pi: fake("pi") }, turns: { records: inputs => inputs.map(i => records.get(i.inboundKey)!) },
      settings: createTurnSettings({ currentSettings: () => settings.currentForTurn() }) });
    const start = async (key: string, scope: string) => {
      records.set(key, record(key, scope));
      await router.startTurn(scope as ThreadKey, [ref(key)], { kind: "user", sender: "1" });
    };
    await start("t1", "private:1");
    await settings.update({ agentBackend: "pi" }, "test");
    await start("t2", "private:1");
    await settings.update({ backendOverrides: { "group:9": "codex" }, codexReasoningEffort: "low" }, "test");
    await start("t3", "group:9");
    await start("t4", "group:8");
    expect(calls).toEqual(["t1:codex:high", "t2:pi:high", "t3:codex:low", "t4:pi:low"]);
    // 回合 id 前缀决定插话 / 恢复交给哪个后端；未知前缀按丢失处理。
    expect(await router.recoverTurn("group:8", "pi:t4")).toBe("lost");
    expect(await router.recoverTurn("group:8", "other:1")).toBe("lost");

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


/** Inbox 记录桩：只填路由与渲染需要的字段。 */
function record(key: string, scope: string, extra: Partial<InboundRecord> = {}): InboundRecord {
  const [type, id] = scope.split(":") as ["group" | "private", string];
  return { key, kind: "user", seq: 1, scope, thread_key: scope, self_id: "2", user_id: type === "private" ? id : "1", group_id: type === "group" ? id : null,
    message_type: type, message_id: key, nickname: "测试", text: "你好", route_text: "你好", time: 1, images: [], attachments: [],
    created_at: new Date().toISOString(), state: "queued", ...extra };
}
const ref = (key: string): InputRef => ({ inboundKey: key, kind: "user", sender: "1", seq: 1, at: 1 });

describe("每轮设置快照", () => {
  it("开轮时冻结后端与档位：回合中热更新不影响本轮，下一轮使用新设置", async () => {
    const dir = tmp();
    const settings = await SettingsStore.open(dir, defaults, new Trace());
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const current = vi.fn(() => settings.currentForTurn());
    const records = new Map<string, InboundRecord>();
    const turns = {
      records: (inputs: readonly Pick<InputRef, "inboundKey">[]) => inputs.map(i => records.get(i.inboundKey)!),
      render: async () => ({ text: "你好", images: [], source: { type: "private" as const, user_id: "1", group_id: null, nickname: "测试" } }),
      binding: (threadKey: string) => ({ threadKey, identity: { kind: "user" as const, sender: "1" }, scope: "private:1", inputs: [] }),
    };
    let block = true;
    const script = new CodexScript();
    script.onTurn = async () => { if (block) await gate; };
    const codex = await codexBackend(dir, script, turns, "low");
    const efforts = () => script.turns.map(t => t.effort);
    const done: string[] = [];
    codex.attach({ onTurnStarted: () => {}, onActivity: () => {}, onTurnCompleted: (_k, turnId, r) => { done.push(r.status); void turnId; } });
    const pi: BackendAdapter = { startTurn: async () => { throw new Error("pi 不应被选中"); }, steer: async () => "no_active_turn", interrupt: async () => {}, recoverTurn: async () => "lost" };
    const router = new BackendRouter({ backends: { codex, pi }, turns, settings: createTurnSettings({ currentSettings: current }) });
    records.set("first", record("first", "private:1"));
    const first = await router.startTurn("private:1", [ref("first")], { kind: "user", sender: "1" });
    expect(first).toEqual({ turnId: expect.stringMatching(/^codex:/) });
    await vi.waitFor(() => expect(efforts()).toEqual(["high"]));
    await settings.update({ codexReasoningEffort: "low", agentBackend: "pi" }, "test");
    current.mockImplementation(() => { throw new Error("回合内不得读取当前设置"); });
    release(); await vi.waitFor(() => expect(done).toEqual(["completed"]));
    expect(efforts()).toEqual(["high"]);
    await settings.update({ agentBackend: "codex" }, "test"); current.mockImplementation(() => settings.currentForTurn());
    block = false;
    records.set("next", record("next", "private:1"));
    await router.startTurn("private:1", [ref("next")], { kind: "user", sender: "1" });
    await vi.waitFor(() => expect(done).toHaveLength(2));
    expect(efforts().at(-1)).toBe("low");
  });
});

describe("auto 档位", () => {
  it.each(["high"])("开轮等待分类 %s，具体档位与模型传给 runner", async output => {
    const dir = tmp(), settings = await SettingsStore.open(dir, { ...defaults, codexReasoningEffort: "auto" });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    clean.push(() => release());
    const complete = vi.fn(async (_prompt: string, _signal: AbortSignal) => output);
    const script = new CodexScript();
    script.onTurn = () => gate;
    const rec = record("auto", "private:1", { text: "看看", reply_to: "quoted" });
    const turns = { records: () => [rec],
      render: async () => ({ text: "看看", images: [], source: { type: "private" as const, user_id: "1", group_id: null, nickname: "测试" } }),
      binding: (threadKey: string) => ({ threadKey, identity: { kind: "user" as const, sender: "1" }, scope: "private:1", inputs: [] }) };
    const codex = await codexBackend(dir, script, turns);
    const seen: SettingsSnapshot[] = [];
    const router = new BackendRouter({ backends: { codex: { startTurn: (k, i, c, snapshot) => { seen.push(snapshot!); return codex.startTurn(k, i, c, snapshot); },
      steer: (k, t, i) => codex.steer(k, t, i), interrupt: k => codex.interrupt(k), recoverTurn: () => codex.recoverTurn() } }, turns,
      settings: createTurnSettings({ currentSettings: () => settings.current(), codexReasoningEffort: "medium", effortRouter: { complete } }) });
    await router.startTurn("private:1", [ref("auto")], { kind: "user", sender: "1" });
    const effort = output === "high" ? "high" : "medium";
    expect(seen[0]).toMatchObject({ codexModel: defaults.codexModel, codexReasoningEffort: effort, effortSource: output === "high" ? "auto" : "auto-fallback" });
    expect(complete).toHaveBeenCalledTimes(1); expect(complete.mock.calls[0]?.length).toBe(2);
    expect((complete.mock.calls[0] as unknown[] | undefined)?.[0]).toContain("有引用：true");
    await settings.update({ codexModel: "changed-after-start", codexReasoningEffort: "low" }, "test");
    await vi.waitFor(() => expect(script.turns).toHaveLength(1));
    release(); await codex.idle();
    expect(script.turns[0]).toMatchObject({ model: defaults.codexModel, effort });
  });
});

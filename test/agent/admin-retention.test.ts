import { afterEach, describe, expect, it, vi } from "vitest";
import { ObsStore } from "../../src/obs/store.js";
import { Trace } from "../../src/shared/trace.js";
import { SettingsStore } from "../../src/agent/settings.js";
import { DEFAULT_SEND_RULES } from "../../src/channel/send-rules.js";
import { loadConfig } from "../../src/config.js";
import { log } from "../../src/shared/log.js";
import { tmp } from "./helpers.js";

const stores: ObsStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); vi.restoreAllMocks(); });
const open = (days = 365) => { const dir = tmp(); const store = new ObsStore(dir, 8, days); stores.push(store); return { dir, store }; };
const day = 86400_000;

describe("管理审计保留策略", () => {
  it("600 次 settings 变更全部保留，超过单票据数量和字节预算也不丢失", async () => {
    vi.spyOn(log, "info").mockImplementation(() => {});
    const { dir, store } = open();
    const settings = await SettingsStore.open(dir, { codexModel: "gpt-6.1-sol", piModel: "deepseek-flash", piThinkingLevel: "low", agentBackend: "codex", backendOverrides: {}, codexReasoningEffort: "high", alertOwner: false, sendRules: { ...DEFAULT_SEND_RULES }, memory: { extract: {} } }, new Trace(store));
    const overrides = Object.fromEntries(Array.from({ length: 50 }, (_, i) => ["group:" + (i + 1), "pi" as const]));
    for (let i = 0; i < 600; i++) await settings.update({ backendOverrides: i % 2 ? {} : overrides }, "test");
    expect(store.events("@settings", 2000)).toHaveLength(600);
    expect(store.events("@settings", 2000).every(e => e.stage === "settings_changed")).toBe(true);
    expect((store.db.prepare("SELECT SUM(length(CAST(detail_json AS BLOB))) bytes FROM events").get() as { bytes: number }).bytes).toBeGreaterThan(256 * 1024);
  });

  it("管理阶段和任意 @ 键仅按独立年龄清理，普通 trace 键仍受预算限制", () => {
    const { store } = open(); const now = 500 * day;
    for (const [key, stage] of [["normal-settings", "settings_changed"], ["normal-prompt", "prompt_changed"], ["normal-reset", "thread_reset"], ["@future", "new_admin_event"]]) {
      for (let i = 0; i < 600; i++) store.append({ key: key!, stage: stage!, scope: "", ts: now - 100 * day, status: "ok", duration_ms: null, detail: { i } });
      store.append({ key: key!, stage: stage!, scope: "", ts: now - 366 * day, status: "ok", duration_ms: null });
    }
    for (let i = 0; i < 20; i++) store.append({ key: "ordinary", stage: "received", scope: "", ts: now - 31 * day, status: "ok", duration_ms: null });
    expect(store.events("ordinary").some(e => e.stage === "events_dropped")).toBe(true);
    // 普通键上的管理事件不能消耗它的普通事件预算。
    expect(store.append({ key: "normal-settings", stage: "received", scope: "", ts: now, status: "ok", duration_ms: null })).toBeDefined();
    store.purge(30, now);
    expect(store.events("ordinary")).toHaveLength(0);
    expect(store.events("normal-settings", 2000)).toHaveLength(601);
    for (const key of ["normal-prompt", "normal-reset", "@future"]) expect(store.events(key, 2000)).toHaveLength(600);
  });

  it("配置默认值与自定义天数生效，非法保留期被拒绝", () => {
    expect(loadConfig({})).toMatchObject({ OBS_ADMIN_RETENTION_DAYS: 365, PI_ARCHIVE_RETENTION_DAYS: 90 });
    const cfg = loadConfig({ OBS_ADMIN_RETENTION_DAYS: "7", PI_ARCHIVE_RETENTION_DAYS: "14" });
    expect(cfg.PI_ARCHIVE_RETENTION_DAYS).toBe(14);
    const { store } = open(cfg.OBS_ADMIN_RETENTION_DAYS);
    store.append({ key: "@settings", stage: "settings_changed", scope: "", ts: 0, status: "ok", duration_ms: null });
    expect(store.purge(30, 8 * day).events).toBe(1);
    expect(() => loadConfig({ OBS_ADMIN_RETENTION_DAYS: "0" })).toThrow();
    expect(() => loadConfig({ PI_ARCHIVE_RETENTION_DAYS: "-1" })).toThrow();
  });
});

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SettingsStore, settingsDefaults } from "../../src/agent/settings.js";
import { loadAgentConfig } from "../../src/agent/config.js";
import { loadCodexModelValidator } from "../../src/agent/codex/model-catalog.js";
import { createTasks } from "../../src/agent/tasks.js";
import { createBackendSelector } from "../../src/agent/backends/select.js";
import { log } from "../../src/shared/log.js";
import { Trace } from "../../src/shared/trace.js";
import { tmp } from "./helpers.js";

const cfg = loadAgentConfig({ CODEX_MODEL: "codex/gpt-test", AGENT_MODEL_ID: "pi-test", AGENT_THINKING_LEVEL: "max" });
const defaults = settingsDefaults(cfg);
const input = { ticket: "t1", text: "帮我调试", hasImages: false, hasQuote: false };
function tasks(settings: SettingsStore, complete = vi.fn(async () => "HIGH")) {
  return { complete, tasks: createTasks({ currentSettings: () => settings.currentForTurn(),
    getBridge: () => { throw Error("unused"); }, imagesDir: tmp(),
    imageBackend: { name: "fake", submit: vi.fn(), collect: vi.fn(), reconcile: vi.fn(), clearReferences: vi.fn() },
    backends: createBackendSelector({ current: () => settings.current(), backends: {} }),
    codexReasoningEffort: "medium", piThinkingLevel: "off", effortRouter: { complete },
  }) };
}

describe("运行时模型与档位", () => {
  it("新字段取 .env 默认；旧文件缺字段补默认，auto 可持久化", async () => {
    expect(defaults).toMatchObject({ codexModel: "codex/gpt-test", piModel: "pi-test", piThinkingLevel: "max" });
    const dir = tmp();
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ version: 1, settings: { agentBackend: "pi", codexReasoningEffort: "low" } }), "utf8");
    const settings = await SettingsStore.open(dir, defaults);
    expect(settings.current()).toEqual({ ...defaults, agentBackend: "pi", codexReasoningEffort: "low" });
    await settings.update({ codexReasoningEffort: "auto", piThinkingLevel: "auto" }, "test");
    expect((await SettingsStore.open(dir, defaults)).current()).toMatchObject({ codexReasoningEffort: "auto", piThinkingLevel: "auto" });
  });
  it("模型校验器拒绝未知模型；失败不改内存与文件", async () => {
    const dir = tmp();
    const settings = await SettingsStore.open(dir, defaults, new Trace(), {
      codexModel: slug => slug === defaults.codexModel, piModel: id => id === defaults.piModel,
    });
    await settings.update({ alertOwner: true }, "test");
    const before = readFileSync(settings.file, "utf8");
    for (const patch of [{ codexModel: "unknown" }, { piModel: "unknown" }, { codexModel: 'bad"slug' }, { piModel: " " }, { piThinkingLevel: "ultra" as never }]) {
      await expect(settings.update(patch, "test")).rejects.toThrow();
      expect(readFileSync(settings.file, "utf8")).toBe(before);
      expect(settings.current()).toEqual({ ...defaults, alertOwner: true });
    }
  });
  it("codex 缓存目录校验与目录不可用回退", async () => {
    const file = path.join(tmp(), "models_cache.json");
    expect((await loadCodexModelValidator(file))("new/model")).toBe(true);
    writeFileSync(file, JSON.stringify({ models: [{ slug: "known" }, { slug: "codex/gpt-6.1-sol" }, { slug: "deepseek/deepseek-flash" }] }), "utf8");
    const validate = await loadCodexModelValidator(file);
    expect(validate("known")).toBe(true); expect(validate("unknown")).toBe(false);
    // 所有提供者都必须精确匹配目录 slug。
    expect(validate("gpt-6.1-sol")).toBe(false); expect(validate("codex/gpt-6.1-sol")).toBe(true); expect(validate("deepseek-flash")).toBe(false);
    expect(validate("deepseek/deepseek-flash")).toBe(true); expect(validate("other/gpt-6.1-sol")).toBe(false);
    writeFileSync(file, "{broken", "utf8");
    const fallback = await loadCodexModelValidator(file);
    expect(fallback("unknown")).toBe(true); expect(fallback("")).toBe(false); expect(fallback('a"')).toBe(false);
  });
  it.each([
    { stored: "gpt-6.1-sol", configured: "codex/gpt-6.1-sol", expected: "codex/gpt-6.1-sol" },
    { stored: "gpt-6.1-sol", configured: "codex/gpt-6-astra", expected: "codex/gpt-6-astra" },
    { stored: undefined, configured: "gpt-6.1-sol", expected: "codex/gpt-6.1-sol" },
    { stored: "unknown", configured: "gpt-6.1-sol", expected: "codex/gpt-6.1-sol" },
  ])("目录可用时无效配置保留原值、告警，回合使用默认：%j", async ({ stored, configured, expected }) => {
    const dir = tmp(), file = path.join(dir, "settings.json"), cacheFile = path.join(dir, "models_cache.json");
    const original = JSON.stringify({ version: 1, settings: { codexModel: stored } });
    writeFileSync(file, original, "utf8");
    writeFileSync(cacheFile, JSON.stringify({ models: [{ slug: "codex/gpt-6.1-sol" }, { slug: "codex/gpt-6-astra" }] }), "utf8");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const settings = await SettingsStore.open(dir, settingsDefaults(loadAgentConfig({ CODEX_MODEL: configured })), new Trace(), {
        codexModel: await loadCodexModelValidator(cacheFile), piModel: () => true,
      });
      expect(settings.current().codexModel).toBe(stored ?? configured);
      expect(warn).toHaveBeenCalledWith("codex model not in catalog; using default for turns", { model: stored ?? configured, fallback: expected });
      expect(await tasks(settings).tasks.snapshotSettings("group:1", undefined, input)).toMatchObject({ codexModel: expected });
      expect(readFileSync(file, "utf8")).toBe(original);
      await expect(settings.update({ codexModel: "gpt-6.1-sol" }, "test")).rejects.toThrow("模型不在可用目录中");
      expect(readFileSync(file, "utf8")).toBe(original);
      await settings.update({ codexModel: "codex/gpt-6-astra" }, "test");
      expect(JSON.parse(readFileSync(file, "utf8")).settings.codexModel).toBe("codex/gpt-6-astra");
      expect(await tasks(settings).tasks.snapshotSettings("group:1", undefined, input)).toMatchObject({ codexModel: "codex/gpt-6-astra" });
    } finally { warn.mockRestore(); }
  });
  it.each([undefined, "{broken"])("目录不可用时保留配置模型并传入回合：%s", async catalog => {
    const dir = tmp(), cacheFile = path.join(dir, "models_cache.json");
    if (catalog !== undefined) writeFileSync(cacheFile, catalog, "utf8");
    const settings = await SettingsStore.open(dir, { ...defaults, codexModel: "gpt-6.1-sol" }, new Trace(), {
      codexModel: await loadCodexModelValidator(cacheFile), piModel: () => true,
    });
    expect(settings.currentForTurn().codexModel).toBe("gpt-6.1-sol");
    await settings.update({ codexModel: "custom/model" }, "test");
    expect(await tasks(settings).tasks.snapshotSettings("group:1", undefined, input)).toMatchObject({ codexModel: "custom/model" });
  });
  it("fixed 快照保存模型与档位，不调用分类", async () => {
    const settings = await SettingsStore.open(tmp(), defaults);
    const rig = tasks(settings);
    expect(await rig.tasks.snapshotSettings("group:1", undefined, input)).toMatchObject({ backend: "codex", codexModel: defaults.codexModel,
      piModel: defaults.piModel, piThinkingLevel: "max", codexReasoningEffort: "high", effortSource: "fixed" });
    expect(rig.complete).not.toHaveBeenCalled();
  });
  it.each(["codex", "pi"] as const)("%s auto 快照冻结具体档位和来源，异步期间不重读设置", async backend => {
    const settings = await SettingsStore.open(tmp(), { ...defaults, agentBackend: backend, codexReasoningEffort: "auto", piThinkingLevel: "auto" });
    let resolve!: (value: string) => void;
    const complete = vi.fn(() => new Promise<string>(r => { resolve = r; }));
    const rig = tasks(settings, complete);
    const snapshot = rig.tasks.snapshotSettings("group:1", undefined, input);
    await settings.update({ codexModel: "next", piModel: "next", codexReasoningEffort: "low", piThinkingLevel: "low" }, "test");
    resolve("xhigh");
    expect(await snapshot).toMatchObject({ backend, codexModel: defaults.codexModel, piModel: defaults.piModel, effortSource: "auto",
      [backend === "codex" ? "codexReasoningEffort" : "piThinkingLevel"]: "xhigh" });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(Object.values(await snapshot)).not.toContain("auto-fallback");
  });
  it.each(["codex", "pi"] as const)("%s 分类失败用启动档位回退，按 scope 选择后端", async backend => {
    const settings = await SettingsStore.open(tmp(), { ...defaults, backendOverrides: { "group:1": backend }, codexReasoningEffort: "auto", piThinkingLevel: "auto" });
    const rig = tasks(settings, vi.fn(async () => "invalid"));
    expect(await rig.tasks.snapshotSettings("group:1", undefined, input)).toMatchObject({ backend, effortSource: "auto-fallback",
      [backend === "codex" ? "codexReasoningEffort" : "piThinkingLevel"]: backend === "codex" ? "medium" : "off" });
  });
  it("配置提供分类默认值、空值禁用与正数超时校验", () => {
    expect(loadAgentConfig({})).toMatchObject({ AUTO_EFFORT_MODEL: "deepseek/deepseek-flash", AUTO_EFFORT_TIMEOUT_MS: 4000 });
    expect(loadAgentConfig({ AUTO_EFFORT_MODEL: "" }).AUTO_EFFORT_MODEL).toBe("");
    expect(() => loadAgentConfig({ AUTO_EFFORT_TIMEOUT_MS: "0" })).toThrow();
    expect(() => loadAgentConfig({ AGENT_THINKING_LEVEL: "auto" })).toThrow();
  });
});

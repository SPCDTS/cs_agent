import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { catalogContextWindow, loadCodexContextWindow, loadCodexModelCatalog } from "../../src/agent/codex/model-catalog.js";
import { piModelCatalog } from "../../src/agent/harness.js";
import { FIXTURES, tmp } from "./helpers.js";

describe("magpie 模型目录", () => {
  it.each([
    ["codex/gpt-6.1-sol", "gpt-6.1-sol"],
    ["gpt-6.1-sol", "codex/gpt-6.1-sol"],
    ["codex/gpt-6.1-sol", "codex/gpt-6.1-sol"],
  ])("目录 %s 可匹配配置 %s", (slug, model) => {
    expect(catalogContextWindow(JSON.stringify({ models: [{ slug, context_window: 500000 }] }), model)).toBe(500000);
  });

  it("精确 slug 优先；前缀回退仍检查窗口有效性", () => {
    const catalog = JSON.stringify({ models: [null, { slug: 123 }, { slug: "other/gpt-6.1-sol", context_window: 123 }, { slug: "codex/gpt-6.1-sol", context_window: 500000 }] });
    expect(catalogContextWindow(catalog, "codex/gpt-6.1-sol")).toBe(500000);
    expect(catalogContextWindow(catalog, "gpt-6-astra")).toBeUndefined();
    for (const context_window of [0, -1, 1.5, "500000"]) {
      expect(catalogContextWindow(JSON.stringify({ models: [{ slug: "codex/gpt-6.1-sol", context_window }] }), "gpt-6.1-sol")).toBeUndefined();
    }
  });

  it("带前缀的离线目录仍回退到无前缀模型缓存", async () => {
    const cacheFile = path.join(tmp("cs-magpie-catalog-"), "models_cache.json");
    writeFileSync(cacheFile, JSON.stringify({ models: [{ slug: "gpt-6.1-sol", context_window: 500000 }] }), "utf8");
    expect(await loadCodexContextWindow({
      command: [process.execPath, path.join(FIXTURES, "fake-codex.mjs")], model: "codex/gpt-6.1-sol", cacheFile,
      env: { FAKE_CODEX_CATALOG: JSON.stringify({ models: [{ slug: "codex/gpt-6.1-sol", context_window: 272000 }, { slug: "codex/gpt-6-astra", context_window: 272000 }] }) },
    })).toBe(500000);
  });
});

describe("面板模型清单 loadCodexModelCatalog", () => {
  it("读取 slug 与有效窗口，跳过非法、重复项", async () => {
    const cacheFile = path.join(tmp("cs-codex-catalog-"), "models_cache.json");
    writeFileSync(cacheFile, JSON.stringify({ models: [
      { slug: "gpt-6.1-sol", context_window: 500000 }, { slug: "codex/gpt-6-astra", context_window: 1.5 }, null, { slug: 7 },
      { slug: 'bad"slug' }, { slug: "gpt-6.1-sol", context_window: 1 },
    ] }), "utf8");
    expect(await loadCodexModelCatalog(cacheFile)).toEqual([{ slug: "gpt-6.1-sol", contextWindow: 500000 }, { slug: "codex/gpt-6-astra" }]);
  });

  it.each([["缺失", undefined], ["损坏", "{not json"], ["形状不对", JSON.stringify({ models: "x" })], ["空目录", JSON.stringify({ models: [] })]])("%s时返回空数组", async (_label, content) => {
    const cacheFile = path.join(tmp("cs-codex-catalog-"), "models_cache.json");
    if (content !== undefined) writeFileSync(cacheFile, content, "utf8");
    expect(await loadCodexModelCatalog(cacheFile)).toEqual([]);
  });
});

describe("面板模型清单 piModelCatalog", () => {
  it("映射窗口与支持档位（与 clampThinkingLevel 同源，不含 auto）；提供者出错返回空", () => {
    const base = { api: "openai-completions", provider: "magpie", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, maxTokens: 1000 };
    const list = [
      { ...base, id: "deepseek-flash", name: "f", reasoning: true, contextWindow: 128000, thinkingLevelMap: { minimal: null, medium: null, xhigh: null, max: "max" } },
      { ...base, id: "plain", name: "p", reasoning: false, contextWindow: 64000 },
      { ...base, id: "nomap", name: "n", reasoning: true, contextWindow: 200000 },
    ];
    const models = { getModels: (provider: string) => { if (provider !== "magpie") throw new Error("unknown"); return list; } } as unknown as Parameters<typeof piModelCatalog>[0];
    expect(piModelCatalog(models, "magpie")).toEqual([
      { id: "deepseek-flash", contextWindow: 128000, thinkingLevels: ["off", "low", "high", "max"] },
      { id: "plain", contextWindow: 64000, thinkingLevels: ["off"] },
      { id: "nomap", contextWindow: 200000, thinkingLevels: ["off", "minimal", "low", "medium", "high"] },
    ]);
    expect(piModelCatalog(models, "other")).toEqual([]);
  });
});

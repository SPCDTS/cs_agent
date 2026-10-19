import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { catalogContextWindow, loadCodexContextWindow } from "../../src/agent/codex/model-catalog.js";
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

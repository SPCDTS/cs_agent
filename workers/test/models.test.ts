import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModels } from "@earendil-works/pi-ai/models";
import { fetchMagpieCatalog, magpieProviderModels } from "../src/magpie";
import { openModels } from "../src/models";
import { ThreadDO } from "../src/thread";

// pool 0.23 不再提供 fetchMock；只替换外部 HTTP 边界，DO 与 SQLite 仍在 workerd 中执行。
beforeEach(() => { vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled in tests")); });
afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.MAGPIE_GATEWAY_KEY;
  await reset();
});

describe("model providers", () => {
  it("selects faux and rejects an unknown model/provider", async () => {
    expect((await openModels(env)).selection).toEqual({ provider: "faux", id: "test" });
    await expect(openModels({ ...env, MODEL_ID: "missing" })).rejects.toThrow("MODEL_ID unavailable");
    await expect(openModels({ ...env, MODEL_PROVIDER: "unknown" })).rejects.toThrow("MODEL_PROVIDER unsupported");
  });

  it("requires an injected DeepSeek secret and resolves its model without making a request", async () => {
    await expect(openModels({ ...env, MODEL_PROVIDER: "deepseek" })).rejects.toThrow("DEEPSEEK_API_KEY missing");
    const runtime = await openModels({ ...env, MODEL_PROVIDER: "deepseek", MODEL_ID: "deepseek-flash", DEEPSEEK_API_KEY: "test-only" });
    expect(runtime.selection).toEqual({ provider: "deepseek", id: "deepseek-flash" });
    expect(process.env.DEEPSEEK_API_KEY).toBe("test-only");
  });

  it("loads the authenticated Magpie catalog and keeps responses endpoints and reasoning levels", async () => {
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      expect(url).toBe("https://magpie.test/v1/models");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-only");
      return Response.json({
      data: [{ id: "codex/example", owned_by: "codex", native_endpoints: ["/v1/responses"], reasoning: true,
        reasoning_levels: ["none", "high"], context_window: 200000, max_output_tokens: 32000, modalities: { input: ["text", "image"] } }],
      });
    });
    const { models, selection } = await openModels({ ...env, MODEL_PROVIDER: "magpie", MODEL_ID: "codex/example",
      MAGPIE_URL: "https://magpie.test/v1", MAGPIE_GATEWAY_KEY: "test-only" });
    expect(selection).toEqual({ provider: "magpie", id: "codex/example" });
    expect(models.getModel("magpie", "codex/example")).toMatchObject({
      api: "openai-responses", contextWindow: 200000, maxTokens: 32000, input: ["text", "image"],
      thinkingLevelMap: { off: "none", high: "high", low: null },
    });
    expect(process.env.MAGPIE_GATEWAY_KEY).toBe("test-only");
  });

  it("filters malformed catalog entries and uses completion defaults", async () => {
    const catalog = await fetchMagpieCatalog("https://magpie.test/v1/", "test-only", async () => Response.json({
      data: [{ id: "other/model" }, { id: "broken", context_window: "bad" }, {}, null],
    }));
    expect(catalog).toEqual([{ id: "other/model" }]);
    expect(magpieProviderModels(catalog, createModels())[0]).toMatchObject({
      api: "openai-completions", contextWindow: 128000, maxTokens: 32768, input: ["text"],
    });
  });

  it("reports unavailable on catalog failure without exposing gateway response bodies", async () => {
    await expect(fetchMagpieCatalog("https://magpie.test", "test-only", async () => new Response("private body", { status: 503 })))
      .rejects.toThrow("magpie 模型目录请求失败: HTTP 503");
    await expect(fetchMagpieCatalog("https://magpie.test", "test-only", async () => new Response("private body")))
      .rejects.toThrow("magpie 模型目录不是有效 JSON");
    vi.mocked(fetch).mockResolvedValue(new Response("private body", { status: 503 }));
    const status = await runInDurableObject(env.THREAD.getByName("unavailable"), async (_instance, state) => {
      const thread = new ThreadDO(state, { ...env, MODEL_PROVIDER: "magpie", MODEL_ID: "any",
        MAGPIE_URL: "https://magpie.test/v1", MAGPIE_GATEWAY_KEY: "test-only" });
      return thread.modelStatus();
    });
    expect(status).toBe("unavailable");
  });
});

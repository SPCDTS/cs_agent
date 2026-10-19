import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createModels } from "@earendil-works/pi-ai/models";
import { createAgentModels, resolveThinkingLevel } from "../../src/agent/harness.js";
import { createMagpieProvider, fetchMagpieCatalog, magpieProviderModels, type MagpieCatalogEntry } from "../../src/agent/magpie-models.js";
import { log } from "../../src/shared/log.js";
import { tmp } from "./helpers.js";

const baseUrl = "https://gateway.example/v1";
const builtin = builtinModels();
const catalog: MagpieCatalogEntry[] = [
  {
    id: "deepseek/deepseek-flash", display_name: "DeepSeek Flash", owned_by: "deepseek",
    context_window: 1000000, max_output_tokens: 384000, reasoning: true,
    reasoning_levels: ["low", "high", "max"], modalities: { input: ["text", "image"] },
    native_endpoints: ["/v1/chat/completions"],
  },
  {
    id: "codex/gpt-6.1-sol", owned_by: "codex", context_window: 500000, max_output_tokens: 128000,
    reasoning: true, reasoning_levels: ["none", "low", "medium", "high", "xhigh"],
    modalities: { input: ["text", "image"] }, native_endpoints: ["/v1/responses"],
  },
  {
    id: "codex/gpt-6-astra", owned_by: "codex", context_window: 500000, max_output_tokens: 128000,
    reasoning: true, reasoning_levels: ["low", "medium", "high", "xhigh"],
    modalities: { input: ["text", "image"] }, native_endpoints: ["/v1/responses"],
  },
];
const dirs: string[] = [];
const home = () => { const dir = tmp("cs-magpie-"); dirs.push(dir); return dir; };
const catalogResponse = () => Response.json({ object: "list", data: catalog });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("magpieProviderModels", () => {
  it("保留 owner 前缀与 display_name，缺省名称回退到完整 ID", () => {
    const models = magpieProviderModels(catalog, builtin);
    expect(models.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "deepseek/deepseek-flash", name: "DeepSeek Flash" },
      { id: "codex/gpt-6.1-sol", name: "codex/gpt-6.1-sol" },
      { id: "codex/gpt-6-astra", name: "codex/gpt-6-astra" },
    ]);
    expect(magpieProviderModels([{ ...catalog[0], display_name: "" }], builtin)[0].name).toBe("");
  });

  it("deepseek-flash 继承内置兼容、思考、价格和输入配置，使用 completions", () => {
    const inherited = builtin.getModel("deepseek", "deepseek-flash")!;
    const [model] = magpieProviderModels(catalog, builtin);
    expect(model).toMatchObject({ api: "openai-completions", contextWindow: 1000000,
      compat: { thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true }, cost: { input: 0.3 } });
    for (const key of ["thinkingLevelMap", "compat", "cost", "promptCache", "inputLimits", "input"] as const) {
      expect(model[key], key).toEqual(inherited[key]);
    }
  });

  it("内置匹配仅移除第一个前缀，继承 promptCache 且不受目录输入模态覆盖", () => {
    const inherited = { ...builtin.getModel("deepseek", "deepseek-flash")!, promptCache: { short: 300, long: 3600 } };
    const lookup = vi.spyOn(builtin, "getModel").mockReturnValue(inherited);
    const [model] = magpieProviderModels([{ ...catalog[0], id: "alias/family/model", modalities: { input: ["audio"] } }], builtin);
    expect(lookup).toHaveBeenCalledWith("deepseek", "family/model");
    expect(model.promptCache).toEqual(inherited.promptCache);
    expect(model.input).toEqual(inherited.input);
  });

  it("内置模型窗口与输出上限优先取目录，缺失时回退内置且不告警", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const inherited = builtin.getModel("deepseek", "deepseek-flash")!;
    const [override, fallback] = magpieProviderModels([
      { ...catalog[0], context_window: 123456, max_output_tokens: 45678 },
      { id: "deepseek-flash", owned_by: "deepseek" },
    ], builtin);
    expect(override).toMatchObject({ contextWindow: 123456, maxTokens: 45678 });
    expect(fallback).toMatchObject({ contextWindow: inherited.contextWindow, maxTokens: inherited.maxTokens, reasoning: inherited.reasoning });
    expect(warn).not.toHaveBeenCalled();
  });

  it("codex Responses 使用目录窗口、输出上限、模态及零价格", () => {
    const [, model] = magpieProviderModels(catalog, builtin);
    expect(model).toMatchObject({ api: "openai-responses", contextWindow: 500000, maxTokens: 128000,
      reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null } });
    const fullModel = createMagpieProvider({ baseUrl, models: [model] }).getModels()[0];
    expect(resolveThinkingLevel(fullModel, "minimal")).toBe("low");
  });

  it.each([
    ["codex", ["/v1/responses"], "openai-responses"],
    ["codex", ["/v1/chat/completions", "/v1/responses"], "openai-responses"],
    ["codex", ["/v1/chat/completions"], "openai-completions"],
    ["codex", undefined, "openai-completions"],
    ["other", ["/v1/responses"], "openai-completions"],
    [undefined, ["/v1/responses"], "openai-completions"],
  ])("API 选择要求 codex owner 与原生 Responses 同时满足：%s %j", (owned_by, native_endpoints, api) => {
    const [model] = magpieProviderModels([{ ...catalog[1], owned_by, native_endpoints }], builtin);
    expect(model.api).toBe(api);
  });

  it.each(["unknown", "deepseek", undefined])("未知模型走默认分支，窗口缺失时告警：owner=%s", owned_by => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const [model] = magpieProviderModels([{ id: "unknown/new-model", owned_by }], builtin);
    expect(model).toMatchObject({ contextWindow: 128000, maxTokens: 32768, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null } });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("magpie model limits missing, using defaults", {
      model: "unknown/new-model", context_window: 128000, max_output_tokens: 32768,
    });
  });

  it("只补缺失的窗口或输出上限，完整目录不告警", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const models = magpieProviderModels([
      { ...catalog[1], context_window: undefined },
      { ...catalog[1], max_output_tokens: undefined }, catalog[1],
    ], builtin);
    expect(models[0]).toMatchObject({ contextWindow: 128000, maxTokens: 128000 });
    expect(models[1]).toMatchObject({ contextWindow: 500000, maxTokens: 32768 });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("输入模态只保留 text/image，缺失时才默认 text", () => {
    const inputs = magpieProviderModels([
      { ...catalog[1], modalities: { input: ["audio", "image", "text", "video"] } },
      { ...catalog[1], modalities: undefined }, { ...catalog[1], modalities: {} },
      { ...catalog[1], modalities: { input: [] } },
    ], builtin).map(model => model.input);
    expect(inputs).toEqual([["image", "text"], ["text"], ["text"], []]);
  });

  it("思考档位同名映射，off 优先映射 none，其余为 null", () => {
    const models = magpieProviderModels([
      { ...catalog[1], reasoning_levels: ["off", "minimal", "low", "medium", "high", "xhigh", "max", "custom"] },
      { ...catalog[1], reasoning_levels: ["off", "none"] },
      { ...catalog[1], reasoning_levels: [] },
    ], builtin);
    expect(models[0].thinkingLevelMap).toEqual({ off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
    expect(models[1].thinkingLevelMap).toEqual({ off: "none", minimal: null, low: null, medium: null, high: null, xhigh: null, max: null });
    expect(Object.values(models[2].thinkingLevelMap!)).toEqual(Array(7).fill(null));
  });
});

describe("fetchMagpieCatalog", () => {
  it.each([baseUrl, `${baseUrl}/`, `${baseUrl}///`])("GET 去除尾部斜杠并传 Bearer，30 秒超时：%s", async url => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(catalogResponse());
    await expect(fetchMagpieCatalog(url, "catalog-key", fetchImpl)).resolves.toEqual(catalog);
    expect(fetchImpl).toHaveBeenCalledWith(`${baseUrl}/models`, {
      method: "GET", headers: { Authorization: "Bearer catalog-key" }, signal: expect.any(AbortSignal),
    });
    expect(timeout).toHaveBeenCalledWith(30000);
  });

  it.each([301, 401, 403, 500, 503])("非 2xx 只报告状态，不读取或泄漏响应体：%s", async status => {
    const response = new Response("sensitive-gateway-response", { status });
    const json = vi.spyOn(response, "json"), text = vi.spyOn(response, "text");
    await expect(fetchMagpieCatalog(baseUrl, "catalog-key", vi.fn<typeof fetch>().mockResolvedValue(response)))
      .rejects.toThrow(`magpie 模型目录请求失败: HTTP ${status}`);
    expect(response.bodyUsed).toBe(false);
    expect(json).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it("空目录保持空数组，缺少 data 数组时报错", async () => {
    await expect(fetchMagpieCatalog(baseUrl, "key", vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [] }))))
      .resolves.toEqual([]);
    for (const body of [null, {}, { data: {} }]) {
      await expect(fetchMagpieCatalog(baseUrl, "key", vi.fn<typeof fetch>().mockResolvedValue(Response.json(body))))
        .rejects.toThrow("magpie 模型目录缺少 data 数组");
    }
  });

  it("无效 JSON 的错误不泄漏响应片段", async () => {
    await expect(fetchMagpieCatalog(baseUrl, "key", vi.fn<typeof fetch>().mockResolvedValue(new Response("sensitive-invalid-json"))))
      .rejects.toThrow(new Error("magpie 模型目录不是有效 JSON"));
  });

  it("目录请求传播网络失败与超时中止", async () => {
    await expect(fetchMagpieCatalog(baseUrl, "key", vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"))))
      .rejects.toThrow("offline");
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }));
    const result = fetchMagpieCatalog(baseUrl, "key", fetchImpl);
    controller.abort(new DOMException("catalog timeout", "TimeoutError"));
    await expect(result).rejects.toThrow("catalog timeout");
  });
});

describe("createMagpieProvider", () => {
  it("注册模型与网关地址，保留输入且仅从 CODEX_MAGPIE_KEY 解析鉴权", async () => {
    const models = magpieProviderModels(catalog, builtin);
    const provider = createMagpieProvider({ baseUrl, models });
    expect(provider).toMatchObject({ id: "magpie", name: "magpie", baseUrl });
    expect(provider.getModels()).toEqual(models.map(model => ({ ...model, provider: "magpie", baseUrl })));
    expect(models[0]).not.toHaveProperty("baseUrl");
    expect(provider.headers).toBeUndefined();
    const registry = createModels();
    registry.setProvider(provider);
    vi.stubEnv("CODEX_MAGPIE_KEY", "");
    vi.stubEnv("DEEPSEEK_API_KEY", "direct-key");
    await expect(registry.getAuth("magpie")).resolves.toBeUndefined();
    vi.stubEnv("CODEX_MAGPIE_KEY", "provider-gateway-key");
    await expect(registry.getAuth("magpie")).resolves.toMatchObject({ auth: { apiKey: "provider-gateway-key" }, source: "CODEX_MAGPIE_KEY" });
  });

  it.each([
    ["deepseek/deepseek-flash", "/chat/completions"], ["codex/gpt-6.1-sol", "/responses"],
  ])("%s 实际出站使用网关 URL、完整模型 ID 与 Bearer", async (modelId, endpoint) => {
    const registry = createModels();
    registry.setProvider(createMagpieProvider({ baseUrl, models: magpieProviderModels(catalog, builtin) }));
    vi.stubEnv("CODEX_MAGPIE_KEY", "outbound-gateway-key");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { message: "test endpoint reached" } }, { status: 400 }));
    const result = await registry.completeSimple(registry.getModel("magpie", modelId)!, {
      messages: [{ role: "user", content: "ping", timestamp: 0 }],
    }, { fetch: fetchImpl, maxRetries: 0, reasoning: "low" });
    expect(result.stopReason).toBe("error");
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(baseUrl + endpoint);
    expect(JSON.parse(String(init!.body)).model).toBe(modelId);
    const headers = new Headers(init!.headers);
    expect(headers.get("Authorization")).toBe("Bearer outbound-gateway-key");
    expect(headers.has("x-openai-actor-authorization")).toBe(false);
  });
});

describe("createAgentModels magpie 启动", () => {
  it("未启用 magpie 时只加载内置模型，不请求目录或等待", async () => {
    const fetchImpl = vi.fn<typeof fetch>(), sleep = vi.fn(async () => {});
    const models = await createAgentModels(home(), undefined, { fetch: fetchImpl, sleep });
    expect(models.getModel("deepseek", "deepseek-flash")).toBeDefined();
    expect(models.getProvider("openai-codex")).toBeDefined();
    expect(models.getProvider("magpie")).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("目录只拉一次，注册 magpie 后保留内置 provider", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => catalogResponse());
    const sleep = vi.fn(async () => {});
    const models = await createAgentModels(home(), { baseUrl, apiKey: "startup-key" }, { fetch: fetchImpl, sleep });
    expect(models.getModels("magpie")).toHaveLength(3);
    expect(models.getModel("magpie", "deepseek/deepseek-flash")).toMatchObject({ baseUrl, provider: "magpie" });
    expect(models.getModel("deepseek", "deepseek-flash")?.baseUrl).toBe("https://api.deepseek.com");
    expect(models.getProvider("openai-codex")).toBeDefined();
    await models.refresh({ providers: ["magpie"] });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("失败后间隔 3 秒重试，第五次重试成功即可启动", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => catalogResponse());
    for (let i = 0; i < 5; i++) fetchImpl.mockRejectedValueOnce(new Error("gateway starting"));
    const sleep = vi.fn(async () => {});
    const models = await createAgentModels(home(), { baseUrl, apiKey: "key" }, { fetch: fetchImpl, sleep });
    expect(models.getModels("magpie")).toHaveLength(3);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(sleep.mock.calls).toEqual(Array(5).fill([3000]));
  });

  it("五次重试仍失败则抛目录不可达错误，不回退直连", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response("sensitive-body", { status: 503 }));
    const sleep = vi.fn(async () => {});
    await expect(createAgentModels(home(), { baseUrl, apiKey: "key" }, { fetch: fetchImpl, sleep }))
      .rejects.toThrow(new Error("magpie 模型目录不可达: magpie 模型目录请求失败: HTTP 503"));
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(sleep.mock.calls).toEqual(Array(5).fill([3000]));
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { createAgentModels, resolveThinkingLevel } from "../src/agent/harness.js";
import { applyEnvAliases, loadConfig, requireProviderApiKey } from "../src/config.js";
import { tmp } from "./agent/helpers.js";

describe("model config defaults", () => {
  it("defaults the intent model to deepseek/deepseek-flash", () => {
    const c = loadConfig({});
    expect(c.AGENT_MODEL_PROVIDER).toBe("deepseek");
    expect(c.AGENT_MODEL_ID).toBe("deepseek-flash");
    expect(c.CODEX_MODEL).toBe("gpt-6.1-sol");
  });

  it("history / codex context defaults and owner resolution", () => {
    const c = loadConfig({ QQ_ALLOW_USERS: "111,222" });
    expect(c).toMatchObject({
      HISTORY_RAW_DAYS: 30, HISTORY_SUMMARY_DAYS: 180, HISTORY_RAW_HARD_MAX_DAYS: 90, HISTORY_SUMMARY_HOUR: 3, QQ_CONTEXT_MAX_CHARS: 2500,
      CODEX_WEB_SEARCH: "live", CODEX_WEB_SEARCH_CONTEXT: "low", CODEX_ROLLOUT_MAX_MB: 50, CODEX_THREAD_MAX_DAYS: 90,
      CODEX_BROWSER: "playwright", owner: "111",
    });
    expect(loadConfig({ QQ_ALLOW_USERS: "111", QQ_OWNER: "999" }).owner).toBe("999");
    expect(loadConfig({ QQ_ALLOW_USERS: "*" }).owner).toBeUndefined();
    expect(() => loadConfig({ CODEX_WEB_SEARCH: "always" })).toThrow(/CODEX_WEB_SEARCH/);
    expect(() => loadConfig({ HISTORY_SUMMARY_HOUR: "24" })).toThrow(/HISTORY_SUMMARY_HOUR/);
    expect(c.COMFY_WORKFLOW_FILE).toBe("");
    expect(c.COMFY_QWEN_CACHE).toBe(false);
    expect(loadConfig({ COMFY_QWEN_CACHE: "true" }).COMFY_QWEN_CACHE).toBe(true);
    expect(loadConfig({ COMFY_WORKFLOW_FILE: "/app/workflows/qwen-image-2.1-turbo-api.json" }).COMFY_WORKFLOW_FILE).toBe(
      "/app/workflows/qwen-image-2.1-turbo-api.json",
    );
    expect(c.CODEX_SANDBOX_NETWORK).toBe(true);
  });
});

describe("v3 router / backend config", () => {
  it("defaults: 奶龙 prefixes, codex backend, no overrides, relay reply mode", () => {
    const c = loadConfig({});
    expect(c.imagePrefixes).toEqual(["奶龙:", "奶龙："]);
    expect(c.AGENT_BACKEND).toBe("codex");
    expect(c.backendOverrides).toEqual({});
    expect(c.CODEX_REPLY_MODE).toBe("relay");
    expect(c.CODEX_REASONING_EFFORT).toBe("high");
  });

  it("parses IMAGE_PREFIXES, AGENT_BACKEND, AGENT_BACKEND_OVERRIDES, CODEX_REPLY_MODE", () => {
    const c = loadConfig({
      IMAGE_PREFIXES: "画:, 画：",
      AGENT_BACKEND: "pi",
      AGENT_BACKEND_OVERRIDES: "group:200000001=codex",
      CODEX_REPLY_MODE: "direct",
    });
    expect(c.imagePrefixes).toEqual(["画:", "画："]);
    expect(c.AGENT_BACKEND).toBe("pi");
    expect(c.backendOverrides).toEqual({ "group:200000001": "codex" });
    expect(c.CODEX_REPLY_MODE).toBe("direct");
    expect(() => loadConfig({ AGENT_BACKEND: "claude" })).toThrow(/AGENT_BACKEND/);
    expect(() => loadConfig({ AGENT_BACKEND_OVERRIDES: "group:1=x" })).toThrow(/配置无效.*AGENT_BACKEND_OVERRIDES/);
    expect(() => loadConfig({ CODEX_REPLY_MODE: "smart" })).toThrow(/CODEX_REPLY_MODE/);
  });
});

describe("DEEPSEEK_APIKEY alias", () => {
  it("copies the alias to DEEPSEEK_API_KEY when the canonical name is unset or empty", () => {
    const env: NodeJS.ProcessEnv = { DEEPSEEK_APIKEY: "k-alias" };
    applyEnvAliases(env);
    expect(env.DEEPSEEK_API_KEY).toBe("k-alias");

    const empty: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: "", DEEPSEEK_APIKEY: "k-alias" };
    applyEnvAliases(empty);
    expect(empty.DEEPSEEK_API_KEY).toBe("k-alias");
  });

  it("never overrides an explicit DEEPSEEK_API_KEY", () => {
    const env: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: "k-main", DEEPSEEK_APIKEY: "k-alias" };
    applyEnvAliases(env);
    expect(env.DEEPSEEK_API_KEY).toBe("k-main");
  });

  it("requireProviderApiKey fails fast without a key and names the alias", () => {
    expect(() => requireProviderApiKey("deepseek", {})).toThrow(/DEEPSEEK_API_KEY 或 DEEPSEEK_APIKEY/);
    expect(() => requireProviderApiKey("deepseek", { DEEPSEEK_API_KEY: "k" })).not.toThrow();
    // OAuth provider 不需要环境变量密钥
    expect(() => requireProviderApiKey("openai-codex", {})).not.toThrow();
  });
});

describe("deepseek-flash model (no network)", () => {
  const saved = { a: process.env.DEEPSEEK_API_KEY, b: process.env.DEEPSEEK_APIKEY };
  afterEach(() => {
    if (saved.a === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = saved.a;
    if (saved.b === undefined) delete process.env.DEEPSEEK_APIKEY;
    else process.env.DEEPSEEK_APIKEY = saved.b;
  });

  it("resolves as an OpenAI-completions model on api.deepseek.com", () => {
    const models = createAgentModels(tmp());
    const m = models.getModel("deepseek", "deepseek-flash");
    expect(m).toBeDefined();
    expect(m).toMatchObject({ provider: "deepseek", api: "openai-completions", baseUrl: "https://api.deepseek.com" });
    // openai-codex 仍可选
    expect(models.getProvider("openai-codex")).toBeDefined();
  });

  it("auth resolves from the aliased env var", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_APIKEY = "test-alias-key";
    applyEnvAliases(process.env);
    const models = createAgentModels(tmp());
    const auth = await models.getAuth("deepseek");
    expect(auth?.auth).toMatchObject({ apiKey: "test-alias-key" });
  });

  it("unsupported thinking levels are adjusted instead of failing", () => {
    const m = createAgentModels(tmp()).getModel("deepseek", "deepseek-flash")!;
    expect(resolveThinkingLevel(m, "low")).toBe("low");
    expect(resolveThinkingLevel(m, "medium")).toBe("high");
    expect(resolveThinkingLevel(m, "off")).toBe("off");
  });
});

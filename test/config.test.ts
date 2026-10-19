import { afterEach, describe, expect, it } from "vitest";
import { createAgentModels, resolveThinkingLevel } from "../src/agent/harness.js";
import { applyEnvAliases, requireProviderApiKey } from "../src/config.js";
import { loadAgentConfig as loadConfig } from "../src/agent/config.js";
import { tmp } from "./agent/helpers.js";

describe("NapCat 服务地址", () => {
  it("默认使用 compose 内网，空值沿用默认，保留宿主机覆盖与凭据校验", () => {
    const defaults = { NAPCAT_HTTP_URL: "http://napcat:3000", NAPCAT_WS_URL: "ws://napcat:3001" };
    expect(loadConfig({})).toMatchObject(defaults);
    expect(loadConfig({ NAPCAT_HTTP_URL: "", NAPCAT_WS_URL: "" })).toMatchObject(defaults);
    const host = { NAPCAT_HTTP_URL: "http://host.docker.internal:3000", NAPCAT_WS_URL: "ws://host.docker.internal:3001" };
    expect(loadConfig(host)).toMatchObject(host);
    for (const key of ["NAPCAT_HTTP_URL", "NAPCAT_WS_URL"]) {
      expect(() => loadConfig({ [key]: "http://user:password@napcat:3000" })).toThrow(/服务 URL 不得包含/);
    }
  });
});

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
    expect(c.CODEX_WRITABLE_ROOTS).toBe("/workspace,/data/prompts");
  });
});

describe("Codex 退出宽限配置", () => {
  it("默认值及毫秒覆盖值保持原单位", () => {
    expect(loadConfig({})).toMatchObject({ CODEX_CLOSE_GRACE_MS: 5000, CODEX_EXIT_GRACE_MS: 15000 });
    expect(loadConfig({ CODEX_CLOSE_GRACE_MS: "250", CODEX_EXIT_GRACE_MS: "750" }))
      .toMatchObject({ CODEX_CLOSE_GRACE_MS: 250, CODEX_EXIT_GRACE_MS: 750 });
  });

  it.each(["0", "-1", "1.5", "invalid"])("拒绝非法宽限时间 %s", value => {
    for (const key of ["CODEX_CLOSE_GRACE_MS", "CODEX_EXIT_GRACE_MS"]) {
      expect(() => loadConfig({ [key]: value })).toThrow(key);
    }
  });
});

describe("v3 router / backend config", () => {
  it("defaults: 奶龙 prefixes, codex backend, no overrides", () => {
    const c = loadConfig({});
    expect(c.imagePrefixes).toEqual(["奶龙:", "奶龙："]);
    expect(c.AGENT_BACKEND).toBe("codex");
    expect(c.backendOverrides).toEqual({});
    expect(c.CODEX_REASONING_EFFORT).toBe("high");
  });

  it("parses IMAGE_PREFIXES, AGENT_BACKEND, AGENT_BACKEND_OVERRIDES", () => {
    const c = loadConfig({
      IMAGE_PREFIXES: "画:, 画：",
      AGENT_BACKEND: "pi",
      AGENT_BACKEND_OVERRIDES: "group:200000001=codex",
    });
    expect(c.imagePrefixes).toEqual(["画:", "画："]);
    expect(c.AGENT_BACKEND).toBe("pi");
    expect(c.backendOverrides).toEqual({ "group:200000001": "codex" });
    expect(() => loadConfig({ AGENT_BACKEND: "claude" })).toThrow(/AGENT_BACKEND/);
    expect(() => loadConfig({ AGENT_BACKEND_OVERRIDES: "group:1=x" })).toThrow(/配置无效.*AGENT_BACKEND_OVERRIDES/);
  });
});

it.each(["relay", "direct", "smart"])("旧 CODEX_REPLY_MODE=%s 被忽略且保留其它配置", mode => {
  const config = loadConfig({ CODEX_REPLY_MODE: mode, AGENT_BACKEND: "pi", CODEX_REASONING_EFFORT: "low" });
  expect(config).not.toHaveProperty("CODEX_REPLY_MODE");
  expect(config).toMatchObject({ AGENT_BACKEND: "pi", CODEX_REASONING_EFFORT: "low" });
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

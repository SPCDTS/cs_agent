import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexRunner, type CodexRunnerOptions } from "../../src/agent/codex/runner.js";
import { FIXTURES, tmp } from "./helpers.js";

afterEach(() => vi.unstubAllEnvs());
function options(): CodexRunnerOptions {
  const dir = tmp("cs-magpie-runner-");
  return { command: [process.execPath, path.join(FIXTURES, "fake-codex.mjs")],
    codexHome: path.join(dir, "codex"), workspaceDir: path.join(dir, "ws"), threadsFile: path.join(dir, "threads.json"),
    sandbox: "workspace-write", timeoutMs: 10_000, env: { FAKE_CODEX_LOG: path.join(dir, "calls.jsonl") } };
}

describe("Codex 提供者凭据", () => {
  it.each([undefined, "", " \t\n"])("仅真正启动 magpie runner 时拒绝空 key：%j", magpieKey => {
    const opts = options();
    expect(() => new CodexRunner({ ...opts, provider: "magpie", magpieKey })).toThrow("配置无效：CODEX_PROVIDER=magpie 需要 CODEX_MAGPIE_KEY");
    expect(() => new CodexRunner({ ...opts, provider: "openai", magpieKey })).not.toThrow();
  });

  it.each(["magpie", "openai"] as const)("%s 的目录查询与 exec/resume 使用一致的受控环境", async provider => {
    vi.stubEnv("CODEX_MAGPIE_KEY", "inherited-must-not-leak");
    vi.stubEnv("OPENAI_API_KEY", "inherited-openai-must-not-leak");
    const opts = options(), dir = path.dirname(opts.threadsFile);
    const catalogLog = path.join(dir, "catalog-env.json");
    const wrapper = path.join(dir, "wrapper.mjs");
    writeFileSync(wrapper, `import { writeFileSync } from 'node:fs';
if (process.argv[2] === 'debug') writeFileSync(${JSON.stringify(catalogLog)}, JSON.stringify(process.env));
await import(${JSON.stringify(pathToFileURL(path.join(FIXTURES, "fake-codex.mjs")).href)});`, "utf8");
    const runner = new CodexRunner({ ...opts, command: [process.execPath, wrapper], provider, magpieKey: "test-explicit-gateway-key",
      env: { ...opts.env, CODEX_MAGPIE_KEY: "wrong", Codex_Magpie_Key: "wrong-alias", OPENAI_BASE_URL: "https://wrong.example", Openai_Api_Key: "wrong-openai", CODEX_API_KEY: "wrong-codex", OBS_TOKEN: "must-not-leak" } });
    await runner.initializeContextUsage();
    await runner.ask("one", { threadKey: "owner" });
    await runner.ask("two", { threadKey: "owner" });
    const calls = readFileSync(opts.env!.FAKE_CODEX_LOG!, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row.phase === "start");
    expect(calls).toHaveLength(2);
    expect(calls[1].argv).toContain("resume");
    for (const env of [JSON.parse(readFileSync(catalogLog, "utf8")), ...calls.map(row => row.env)]) {
      expect(env.CODEX_MAGPIE_KEY).toBe(provider === "magpie" ? "test-explicit-gateway-key" : undefined);
      expect(env.OBS_TOKEN).toBeUndefined();
      expect(Object.keys(env).filter(key => key.toUpperCase() === "CODEX_MAGPIE_KEY")).toEqual(provider === "magpie" ? ["CODEX_MAGPIE_KEY"] : []);
      if (provider === "magpie") expect(Object.keys(env).some(key => key.toUpperCase().startsWith("OPENAI_") || key.toUpperCase() === "CODEX_API_KEY")).toBe(false);
    }
  });
});

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CodexRunner } from "../../src/agent/codex/runner.js";
import { RecallTokens } from "../../src/context/media-recall-server.js";
import { FIXTURES, tmp } from "./helpers.js";

function rig(provider: "magpie" | "openai" = "openai") {
  const dir = tmp("cs-compact-"), codexHome = path.join(dir, "codex"), logFile = path.join(dir, "calls.jsonl");
  mkdirSync(codexHome);
  writeFileSync(path.join(codexHome, "config.toml"), `model_provider="${provider}"\n`, "utf8");
  const tokens = new RecallTokens({ recall: async () => ({ text: "ok", images: [] }) });
  const issue = vi.spyOn(tokens, "issue");
  const runner = new CodexRunner({
    command: [process.execPath, path.join(FIXTURES, "fake-compact-codex.mjs")], provider, magpieKey: "test-gateway-key",
    codexHome, workspaceDir: path.join(dir, "ws"), threadsFile: path.join(dir, "threads.json"),
    sandbox: "workspace-write", timeoutMs: 10_000, recallTokens: tokens,
    env: { FAKE_CODEX_LOG: logFile, FAKE_CODEX_THREAD: "compact-thread", FAKE_CODEX_SLEEP_MS: "80", OBS_TOKEN: "must-not-leak" },
  });
  const calls = (): Record<string, any>[] => existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  return { runner, issue, calls, dir, codexHome };
}

describe("CodexRunner.compactThread", () => {
  it("没有对应线程时 unchanged，不启动进程或创建会话", async () => {
    const r = rig();
    expect(await r.runner.compactThread("owner")).toBe("unchanged");
    expect(await r.runner.compactThread("private:9")).toBe("unchanged");
    expect(r.calls()).toEqual([]);
    expect(r.issue).not.toHaveBeenCalled();
    await expect(r.runner.compactThread("shared" as "owner")).rejects.toThrow("非法");
  });

  it.each(["magpie", "openai"] as const)("在 %s 回合后串行压缩，复用配置和环境，不申请 MCP 令牌", async provider => {
    const r = rig(provider);
    const turn = r.runner.ask("first", { threadKey: "owner", ticket: "compact-before", qqAccess: "all" });
    const compact = r.runner.compactThread("owner");
    const next = r.runner.ask("second", { threadKey: "owner", ticket: "compact-after", qqAccess: "all" });
    expect(await turn).toBe("answer to: first");
    expect(await compact).toBe("compacted");
    expect(await next).toBe("answer to: second");
    const calls = r.calls(), start = calls.find(c => c.phase === "compact-start")!;
    expect(calls.map(c => c.phase)).toEqual(["start", "end", "compact-start", "rpc", "rpc", "rpc", "start", "end"]);
    expect(start.t).toBeGreaterThanOrEqual(calls[1].t);
    expect(start.argv).toEqual(["app-server"]);
    expect(start.config).toBe(`model_provider="${provider}"\n`);
    expect(start.env.CODEX_HOME).toBe(r.codexHome);
    expect(start.env.CODEX_MAGPIE_KEY).toBe(provider === "magpie" ? "test-gateway-key" : undefined);
    expect(start.env.OBS_TOKEN).toBeUndefined();
    expect(calls.filter(c => c.phase === "rpc")).toEqual([
      { phase: "rpc", method: "initialize", params: { clientInfo: { name: "cs_agent_compact", version: "0.1.0" } } },
      { phase: "rpc", method: "thread/resume", params: { threadId: "compact-thread" } },
      { phase: "rpc", method: "thread/compact/start", params: { threadId: "compact-thread" } },
    ]);
    expect(r.issue).toHaveBeenCalledTimes(2);
    expect(await r.runner.readThreadIds()).toEqual({ owner: "compact-thread" });
    expect(calls.filter(c => c.phase === "start")[1].argv).toContain("resume");
  });

  it("压缩失败保留映射，并释放同键队列供重置使用", async () => {
    const r = rig();
    writeFileSync(r.runner.opts.threadsFile, JSON.stringify({ owner: { thread_id: "existing" } }), "utf8");
    r.runner.opts.env!.FAKE_COMPACT_FAIL = "1";
    const failed = r.runner.compactThread("owner");
    const reset = r.runner.resetThread("owner");
    await expect(failed).rejects.toThrow("thread/compact/start");
    expect(await reset).toBe("existing");
    expect(await r.runner.compactThread("owner")).toBe("unchanged");
  });
});

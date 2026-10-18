import { existsSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexRunner } from "../../src/agent/codex-runner.js";
import { purgeCodexTrace } from "../../src/agent/codex-trace.js";
import { loadConfig } from "../../src/config.js";
import { FIXTURES, tmp } from "./helpers.js";

const dirs: string[] = [];
const temp = () => { const dir = tmp("cs-trace-test-"); dirs.push(dir); return dir; };
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function runner(dir: string, traceRetentionDays?: number) {
  return new CodexRunner({
    command: [process.execPath, path.join(FIXTURES, "fake-codex.mjs")],
    codexHome: path.join(dir, "codex"), workspaceDir: path.join(dir, "ws"),
    threadsFile: path.join(dir, "codex-threads.json"), sandbox: "workspace-write", timeoutMs: 10_000,
    traceRetentionDays,
    env: { FAKE_CODEX_LOG: path.join(dir, "calls.jsonl"), CODEX_ROLLOUT_TRACE_ROOT: "/wrong", Codex_Rollout_Trace_Root: "/also-wrong" },
  });
}

function childEnv(dir: string): NodeJS.ProcessEnv {
  return JSON.parse(readFileSync(path.join(dir, "calls.jsonl"), "utf8").split("\n")[0]!).env as NodeJS.ProcessEnv;
}

describe("Codex 官方 trace", () => {
  it("默认保留 14 天，接受 0 关闭并拒绝非法保留期", () => {
    expect(loadConfig({}).CODEX_TRACE_RETENTION_DAYS).toBe(14);
    expect(loadConfig({ CODEX_TRACE_RETENTION_DAYS: "0" }).CODEX_TRACE_RETENTION_DAYS).toBe(0);
    expect(loadConfig({ CODEX_TRACE_RETENTION_DAYS: "30" }).CODEX_TRACE_RETENTION_DAYS).toBe(30);
    for (const value of ["-1", "1.5", "NaN", "Infinity"]) {
      expect(() => loadConfig({ CODEX_TRACE_RETENTION_DAYS: value })).toThrow(/CODEX_TRACE_RETENTION_DAYS/);
    }
  });

  it("创建 trace 目录并用精确环境变量将子进程限制在 CODEX_HOME 下", async () => {
    const dir = temp();
    await runner(dir).ask("测试");
    expect(childEnv(dir).CODEX_ROLLOUT_TRACE_ROOT).toBe(path.join(dir, "codex", "trace"));
    expect(childEnv(dir).Codex_Rollout_Trace_Root).toBeUndefined();
    expect(existsSync(path.join(dir, "codex", "trace"))).toBe(true);
  });

  it("0 关闭 trace，清除父进程和额外环境中继承的大小写别名", async () => {
    vi.stubEnv("CODEX_ROLLOUT_TRACE_ROOT", "/inherited");
    const dir = temp();
    await runner(dir, 0).ask("测试");
    expect(Object.keys(childEnv(dir)).some(key => key.toUpperCase() === "CODEX_ROLLOUT_TRACE_ROOT")).toBe(false);
    expect(existsSync(path.join(dir, "codex", "trace"))).toBe(false);
  });

  it("递归清除过期文件，保留边界、近期文件和 trace 外文件", async () => {
    const dir = temp(), root = path.join(dir, "trace"), nested = path.join(root, "thread", "turn");
    mkdirSync(nested, { recursive: true });
    const now = Date.UTC(2026, 9, 18), cutoff = now - 14 * 86_400_000;
    const files = [[path.join(root, "old.jsonl"), cutoff - 1000], [path.join(nested, "old.json"), cutoff - 1000],
      [path.join(root, "boundary.json"), cutoff], [path.join(root, "recent.json"), now], [path.join(dir, "outside.json"), cutoff - 1000]] as const;
    for (const [file, time] of files) { writeFileSync(file, "payload"); utimesSync(file, time / 1000, time / 1000); }
    expect(await purgeCodexTrace(dir, 14, now)).toBe(2);
    expect(files.map(([file]) => existsSync(file))).toEqual([false, false, true, true, true]);
    expect(existsSync(nested)).toBe(true);
    expect(await purgeCodexTrace(dir, 14, now)).toBe(0);
  });

  it("不跟随 trace 内目录链接或作为 trace 根目录的链接", async () => {
    const dir = temp(), outside = temp(), root = path.join(dir, "trace"), linked = path.join(root, "external");
    mkdirSync(root);
    const file = path.join(outside, "old.json"); writeFileSync(file, "outside"); utimesSync(file, 0, 0);
    symlinkSync(outside, linked, "junction");
    expect(await purgeCodexTrace(dir, 14)).toBe(0);
    expect(existsSync(file)).toBe(true);
    const other = temp(); symlinkSync(outside, path.join(other, "trace"), "junction");
    expect(await purgeCodexTrace(other, 14)).toBe(0);
    expect(existsSync(file)).toBe(true);
  });

  it("关闭时不清除历史 trace，缺少目录时不报错", async () => {
    const dir = temp();
    expect(await purgeCodexTrace(dir, 14)).toBe(0);
    mkdirSync(path.join(dir, "trace"));
    const file = path.join(dir, "trace", "old.json"); writeFileSync(file, "old"); utimesSync(file, 0, 0);
    expect(await purgeCodexTrace(dir, 0)).toBe(0);
    expect(existsSync(file)).toBe(true);
    await expect(purgeCodexTrace(dir, -1)).rejects.toThrow(/保留期/);
  });
});

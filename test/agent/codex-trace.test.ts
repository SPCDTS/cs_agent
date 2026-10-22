import { existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexRunner } from "../../src/agent/codex/runner.js";
import { purgeCodexTrace } from "../../src/agent/codex/trace.js";
import { loadConfig } from "../../src/config.js";
import { FIXTURES, tmp } from "./helpers.js";
import { fakeSpawn, noKill } from "./codex-app-server/fake-app-server.js";

const dirs: string[] = [];
const temp = () => { const dir = tmp("cs-trace-test-"); dirs.push(dir); return dir; };
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

/** 启动常驻 app-server（内存版），返回它拿到的环境。 */
async function appServerEnv(dir: string, traceRetentionDays?: number): Promise<NodeJS.ProcessEnv> {
  const fake = fakeSpawn();
  const runner = new CodexRunner({
    command: [process.execPath, path.join(FIXTURES, "fake-codex.mjs")],
    codexHome: path.join(dir, "codex"), workspaceDir: path.join(dir, "ws"),
    threadsFile: path.join(dir, "codex-threads.json"), sandbox: "workspace-write", spawn: fake.spawn, supervisor: { ...noKill },
    traceRetentionDays,
    env: { CODEX_ROLLOUT_TRACE_ROOT: "/wrong", Codex_Rollout_Trace_Root: "/also-wrong" },
  });
  await runner.start();
  await runner.stop();
  return fake.calls[0]!.env;
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

  it("总量默认 512 MiB，0 不限，拒绝非法或超出安全字节数的配置", async () => {
    expect(loadConfig({}).CODEX_TRACE_MAX_MB).toBe(512);
    expect(loadConfig({ CODEX_TRACE_MAX_MB: "0" }).CODEX_TRACE_MAX_MB).toBe(0);
    expect(loadConfig({ CODEX_TRACE_MAX_MB: "128" }).CODEX_TRACE_MAX_MB).toBe(128);
    for (const value of ["-1", "1.5", "NaN", "Infinity", "9007199254740991"]) {
      expect(() => loadConfig({ CODEX_TRACE_MAX_MB: value })).toThrow(/CODEX_TRACE_MAX_MB/);
      await expect(purgeCodexTrace(temp(), 14, Date.now(), Number(value))).rejects.toThrow(/总量上限/);
    }
  });

  it("先删除过期文件，再跨子目录按 mtime 清理到总量恰好达标", async () => {
    const dir = temp(), root = path.join(dir, "trace"), nested = path.join(root, "nested");
    mkdirSync(nested, { recursive: true });
    const now = Date.UTC(2026, 9, 18), mb = 1024 * 1024;
    const files = [
      [path.join(root, "expired.json"), now - 15 * 86_400_000, 100],
      [path.join(nested, "z-oldest.json"), now - 3000, mb / 2],
      [path.join(root, "a-middle.json"), now - 2000, mb / 2],
      [path.join(root, "latest.json"), now, mb],
    ] as const;
    for (const [file, time, size] of files) { writeFileSync(file, Buffer.alloc(size)); utimesSync(file, time / 1000, time / 1000); }
    expect(await purgeCodexTrace(dir, 14, now, 1)).toEqual({ removed: 3, bytes: mb + 100 });
    expect(files.map(([file]) => existsSync(file))).toEqual([false, false, false, true]);
    expect(existsSync(nested)).toBe(true);
    expect(await purgeCodexTrace(dir, 14, now, 1)).toEqual({ removed: 0, bytes: 0 });
  });

  it("按天清理后未超限时不额外删除；0 总量上限仍执行过期清理", async () => {
    const dir = temp(), root = path.join(dir, "trace"); mkdirSync(root);
    const old = path.join(root, "old"), recent = path.join(root, "recent");
    writeFileSync(old, Buffer.alloc(1024 * 1024)); utimesSync(old, 0, 0);
    writeFileSync(recent, Buffer.alloc(1024 * 1024));
    expect(await purgeCodexTrace(dir, 14, Date.now(), 1)).toEqual({ removed: 1, bytes: 1024 * 1024 });
    writeFileSync(old, "old"); utimesSync(old, 0, 0);
    writeFileSync(recent, Buffer.alloc(2 * 1024 * 1024));
    expect(await purgeCodexTrace(dir, 14, Date.now(), 0)).toEqual({ removed: 1, bytes: 3 });
    expect(existsSync(recent)).toBe(true);
  });

  it("关闭按天清理仍可独立限制总量；链接目标不计入容量也不删除", async () => {
    const dir = temp(), outside = temp(), root = path.join(dir, "trace"); mkdirSync(root);
    const external = path.join(outside, "external"); writeFileSync(external, Buffer.alloc(2 * 1024 * 1024));
    symlinkSync(outside, path.join(root, "linked"), "junction");
    const file = path.join(root, "old"); writeFileSync(file, Buffer.alloc(1024 * 1024)); utimesSync(file, 0, 0);
    expect(await purgeCodexTrace(dir, 0, Date.now(), 1)).toEqual({ removed: 0, bytes: 0 });
    writeFileSync(file, Buffer.alloc(2 * 1024 * 1024));
    expect(await purgeCodexTrace(dir, 0, Date.now(), 0)).toEqual({ removed: 0, bytes: 0 });
    expect(await purgeCodexTrace(dir, 0, Date.now(), 1)).toEqual({ removed: 1, bytes: 2 * 1024 * 1024 });
    expect(existsSync(external)).toBe(true);
    expect(existsSync(path.join(root, "linked"))).toBe(true);
  });

  it("创建 trace 目录并用精确环境变量将子进程限制在 CODEX_HOME 下", async () => {
    const dir = temp();
    const env = await appServerEnv(dir);
    expect(env.CODEX_ROLLOUT_TRACE_ROOT).toBe(path.join(dir, "codex", "trace"));
    expect(env.Codex_Rollout_Trace_Root).toBeUndefined();
    expect(existsSync(path.join(dir, "codex", "trace"))).toBe(true);
  });

  it("0 关闭 trace，清除父进程和额外环境中继承的大小写别名", async () => {
    vi.stubEnv("CODEX_ROLLOUT_TRACE_ROOT", "/inherited");
    const dir = temp();
    const env = await appServerEnv(dir, 0);
    expect(Object.keys(env).some(key => key.toUpperCase() === "CODEX_ROLLOUT_TRACE_ROOT")).toBe(false);
    expect(existsSync(path.join(dir, "codex", "trace"))).toBe(false);
  });

  it("递归清除过期文件，保留边界、近期文件和 trace 外文件", async () => {
    const dir = temp(), root = path.join(dir, "trace"), nested = path.join(root, "thread", "turn");
    mkdirSync(nested, { recursive: true });
    const now = Date.UTC(2026, 9, 18), cutoff = now - 14 * 86_400_000;
    const files = [[path.join(root, "old.jsonl"), cutoff - 1000], [path.join(nested, "old.json"), cutoff - 1000],
      [path.join(root, "boundary.json"), cutoff], [path.join(root, "recent.json"), now], [path.join(dir, "outside.json"), cutoff - 1000]] as const;
    for (const [file, time] of files) { writeFileSync(file, "payload"); utimesSync(file, time / 1000, time / 1000); }
    expect(await purgeCodexTrace(dir, 14, now)).toEqual({ removed: 2, bytes: 14 });
    expect(files.map(([file]) => existsSync(file))).toEqual([false, false, true, true, true]);
    expect(existsSync(nested)).toBe(true);
    expect(await purgeCodexTrace(dir, 14, now)).toEqual({ removed: 0, bytes: 0 });
  });

  it("不跟随 trace 内目录链接或作为 trace 根目录的链接", async () => {
    const dir = temp(), outside = temp(), root = path.join(dir, "trace"), linked = path.join(root, "external");
    mkdirSync(root);
    const file = path.join(outside, "old.json"); writeFileSync(file, "outside"); utimesSync(file, 0, 0);
    symlinkSync(outside, linked, "junction");
    expect(await purgeCodexTrace(dir, 14)).toEqual({ removed: 0, bytes: 0 });
    expect(existsSync(file)).toBe(true);
    const other = temp(); symlinkSync(outside, path.join(other, "trace"), "junction");
    expect(await purgeCodexTrace(other, 14)).toEqual({ removed: 0, bytes: 0 });
    expect(existsSync(file)).toBe(true);
  });

  it("关闭时不清除历史 trace，缺少目录时不报错", async () => {
    const dir = temp();
    expect(await purgeCodexTrace(dir, 14)).toEqual({ removed: 0, bytes: 0 });
    mkdirSync(path.join(dir, "trace"));
    const file = path.join(dir, "trace", "old.json"); writeFileSync(file, "old"); utimesSync(file, 0, 0);
    expect(await purgeCodexTrace(dir, 0)).toEqual({ removed: 0, bytes: 0 });
    expect(existsSync(file)).toBe(true);
    await expect(purgeCodexTrace(dir, -1)).rejects.toThrow(/保留期/);
  });
});

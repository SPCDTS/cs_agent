import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CodexRunner, CodexTimeoutError } from "../../src/agent/codex/runner.js";
import { FIXTURES, tmp } from "./helpers.js";

function setup(env: NodeJS.ProcessEnv = {}, options: { timeoutMs?: number; closeGraceMs?: number; exitGraceMs?: number } = {}) {
  const dir = tmp("cs-codex-exit-");
  const log = path.join(dir, "calls.jsonl");
  const outputFile = path.join(dir, "last.txt");
  const runner = new CodexRunner({
    command: [process.execPath, path.join(FIXTURES, "fake-codex.mjs")],
    codexHome: path.join(dir, "codex"), workspaceDir: path.join(dir, "ws"), threadsFile: path.join(dir, "threads.json"),
    sandbox: "workspace-write", timeoutMs: 10000, closeGraceMs: 150, exitGraceMs: 250, ...options,
    env: { FAKE_CODEX_LOG: log, ...env },
  });
  const calls = () => readFileSync(log, "utf8").trim().split("\n").map(l => JSON.parse(l) as { phase: string; pid: number; t: number });
  return { runner, outputFile, calls };
}

describe("Codex exit / close grace", () => {
  it("正常 exit + close 不消耗 grace，保留输出文件且移除取消监听", async () => {
    const { runner, outputFile } = setup({}, { closeGraceMs: 10000, exitGraceMs: 10000 });
    const abort = new AbortController();
    const remove = vi.spyOn(abort.signal, "removeEventListener");
    const start = Date.now();
    await expect(runner.ask("normal", { threadKey: "owner", outputFile, signal: abort.signal })).resolves.toBe("answer to: normal");
    expect(Date.now() - start).toBeLessThan(5000);
    expect(readFileSync(outputFile, "utf8")).toBe("answer to: normal");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    abort.abort();
    await expect(runner.ask("next", { threadKey: "owner" })).resolves.toBe("answer to: next");
  });

  it("主进程退出、孙进程持有管道时在 close grace 后成功返回", async () => {
    const { runner, outputFile, calls } = setup({ FAKE_CODEX_HOLD_PIPE: "1" });
    const start = Date.now();
    await expect(runner.ask("pipe", { threadKey: "owner", outputFile })).resolves.toBe("answer to: pipe");
    expect(Date.now() - start).toBeLessThan(5000);
    expect(Date.now() - calls().find(c => c.phase === "end")!.t).toBeGreaterThanOrEqual(100);
    expect(readFileSync(outputFile, "utf8")).toBe("answer to: pipe");
  });

  // 生产环境（Linux）codex 以独立进程组启动，killTree 杀整组，孤儿孙进程一并清理；
  // Windows 下 fixture 的孙进程是 detached 的新进程组，父进程退出后 taskkill /T 够不到，无法验证，按平台跳过。
  it.skipIf(process.platform === "win32")("close grace 后清理持有 stdout 的孙进程", async () => {
    const { runner, calls } = setup({ FAKE_CODEX_HOLD_PIPE: "1" });
    await runner.ask("cleanup", { threadKey: "owner" });
    const pid = calls().find(c => c.phase === "holder")!.pid;
    // 假孙进程有 8 秒自退出保险；此处必须验证主动清理，不把自然退出当作成功。
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 1000 });
  });

  it("close grace 内继续读取尾部 JSONL，包括没有换行的最后一行", async () => {
    const tail = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "late answer" } });
    const { runner } = setup({ FAKE_CODEX_HOLD_PIPE: "1", FAKE_CODEX_NO_OUT: "1", FAKE_CODEX_PIPE_TAIL: tail }, { closeGraceMs: 1000 });
    await expect(runner.ask("tail", { threadKey: "owner" })).resolves.toBe("late answer");
  });

  it("完成事件不能覆盖已知非零退出码", async () => {
    const { runner } = setup({ FAKE_CODEX_HOLD_PIPE: "1", FAKE_CODEX_EXIT_CODE: "7" });
    await expect(runner.ask("failed", { threadKey: "owner" })).rejects.toThrow(/codex 执行失败/);
  });

  it("强制关闭管道时缺少 turn.completed 不能把半成品当作成功", async () => {
    const { runner } = setup({ FAKE_CODEX_HOLD_PIPE: "1", FAKE_CODEX_NO_COMPLETED: "1" });
    await expect(runner.ask("unfinished", { threadKey: "owner" })).rejects.toThrow(/turn.completed/);
  });

  it("完成且输出非空、主进程不退出时在 exit grace 后成功返回", async () => {
    const { runner, outputFile, calls } = setup({ FAKE_CODEX_SLEEP_AFTER_OUT_MS: "8000" });
    const start = Date.now();
    await expect(runner.ask("done", { threadKey: "owner", outputFile })).resolves.toBe("answer to: done");
    expect(Date.now() - start).toBeLessThan(5000);
    expect(calls().some(c => c.phase === "end")).toBe(false);
    expect(readFileSync(outputFile, "utf8")).toBe("answer to: done");
  });

  it("exit grace 后清理未退出的主进程", async () => {
    const { runner, calls } = setup({ FAKE_CODEX_SLEEP_AFTER_OUT_MS: "8000" });
    await runner.ask("cleanup", { threadKey: "owner" });
    await vi.waitFor(() => expect(() => process.kill(calls()[0].pid, 0)).toThrow(), { timeout: 1000 });
  });

  it.each([
    { FAKE_CODEX_NO_OUT: "1" },
    { FAKE_CODEX_TEXT: " \n " },
    { FAKE_CODEX_NO_COMPLETED: "1" },
  ])("完成与非空输出缺一不可，否则保留总超时：%j", async env => {
    const { runner, outputFile } = setup({ ...env, FAKE_CODEX_SLEEP_AFTER_OUT_MS: "8000" }, { timeoutMs: 1000 });
    writeFileSync(outputFile, "stale output", "utf8");
    await expect(runner.ask("incomplete", { threadKey: "owner", outputFile })).rejects.toBeInstanceOf(CodexTimeoutError);
    if (env.FAKE_CODEX_NO_OUT) expect(existsSync(outputFile)).toBe(false);
  });

  it("完成后的取消优先于成功兜底", async () => {
    const { runner } = setup({ FAKE_CODEX_SLEEP_AFTER_OUT_MS: "8000" });
    const abort = new AbortController();
    await expect(runner.ask("cancel", { threadKey: "owner", signal: abort.signal,
      onJsonEvent: event => { if (event.type === "turn.completed") abort.abort(); },
    })).rejects.toThrow("aborted");
  });

  it("spawn 失败直接报错，不等待超时", async () => {
    const { runner } = setup();
    runner.opts.command = [path.join(runner.opts.codexHome, "nonexistent-codex")];
    await expect(runner.ask("missing binary", { threadKey: "owner" })).rejects.toThrow(/ENOENT/);
  });
});

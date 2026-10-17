import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexRunner, CodexTimeoutError, extractThreadId } from "../../src/agent/tools/ask-codex.js";
import { FIXTURES, tmp } from "./helpers.js";

function setup(extra: { sleepMs?: number; timeoutMs?: number; thread?: string } = {}) {
  const dir = tmp();
  const logFile = path.join(dir, "calls.jsonl");
  const runner = new CodexRunner({
    command: [process.execPath, path.join(FIXTURES, "fake-codex.mjs")],
    codexHome: path.join(dir, "codex"),
    workspaceDir: path.join(dir, "ws"),
    sessionFile: path.join(dir, "codex-session.json"),
    sandbox: "workspace-write",
    timeoutMs: extra.timeoutMs ?? 10_000,
    env: {
      FAKE_CODEX_LOG: logFile,
      FAKE_CODEX_SLEEP_MS: String(extra.sleepMs ?? 0),
      FAKE_CODEX_THREAD: extra.thread ?? "thread-123",
    },
  });
  const calls = (): any[] =>
    existsSync(logFile)
      ? readFileSync(logFile, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
      : [];
  return { dir, runner, calls };
}

describe("extractThreadId", () => {
  it("reads thread.started thread_id and tolerates session_id variants", () => {
    expect(extractThreadId({ type: "thread.started", thread_id: "a" })).toBe("a");
    expect(extractThreadId({ type: "session.created", session_id: "b" })).toBe("b");
    expect(extractThreadId({ msg: { type: "session_configured", session_id: "c" } })).toBe("c");
    expect(extractThreadId({ type: "turn.started" })).toBeUndefined();
  });
});

describe("CodexRunner", () => {
  it("first turn captures thread id, persists it, returns -o text; passes CODEX_HOME and stdin prompt", async () => {
    const { dir, runner, calls } = setup();
    const answer = await runner.ask("hello there");
    expect(answer).toBe("answer to: hello there");
    const saved = JSON.parse(readFileSync(path.join(dir, "codex-session.json"), "utf8"));
    expect(saved.thread_id).toBe("thread-123");
    const [start] = calls();
    expect(start.argv[0]).toBe("exec");
    expect(start.argv).toEqual(
      expect.arrayContaining(["--json", "--skip-git-repo-check", "-o", "-C", path.join(dir, "ws"), "-s", "workspace-write"]),
    );
    expect(start.argv.at(-1)).toBe("-");
    expect(start.stdin).toBe("hello there");
    expect(start.codexHome).toBe(path.join(dir, "codex"));
  });

  it("later turns use `exec resume <id> ... -`", async () => {
    const { runner, calls } = setup();
    await runner.ask("one");
    await runner.ask("two");
    const starts = calls().filter((c) => c.phase === "start");
    expect(starts[1].argv.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(starts[1].argv.slice(-2)).toEqual(["thread-123", "-"]);
    expect(starts[1].argv).toEqual(expect.arrayContaining(["-c", 'sandbox_mode="workspace-write"']));
    expect(starts[1].stdin).toBe("two");
  });

  it("resume failure (lost session) starts a fresh session and overwrites the record", async () => {
    const { dir, runner, calls } = setup({ thread: "thread-new" });
    writeFileSync(path.join(dir, "codex-session.json"), JSON.stringify({ thread_id: "missing-1" }));
    const answer = await runner.ask("again");
    expect(answer).toBe("answer to: again");
    const starts = calls().filter((c) => c.phase === "start");
    expect(starts.map((s) => s.argv[1])).toEqual(["resume", "--json"]);
    expect(JSON.parse(readFileSync(path.join(dir, "codex-session.json"), "utf8")).thread_id).toBe("thread-new");
  });

  it("timeout kills the process tree and throws CodexTimeoutError", async () => {
    const { runner, calls } = setup({ sleepMs: 20_000, timeoutMs: 800 });
    const t0 = Date.now();
    await expect(runner.ask("slow")).rejects.toBeInstanceOf(CodexTimeoutError);
    expect(Date.now() - t0).toBeLessThan(8000);
    const pid = calls()[0].pid as number;
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(calls().some((c) => c.phase === "end")).toBe(false);
  });

  it("mutex: concurrent asks run one at a time in submission order", async () => {
    const { runner, calls } = setup({ sleepMs: 300 });
    const results = await Promise.all([runner.ask("A"), runner.ask("B"), runner.ask("C")]);
    expect(results).toEqual(["answer to: A", "answer to: B", "answer to: C"]);
    const recs = calls();
    expect(recs.map((r) => r.phase)).toEqual(["start", "end", "start", "end", "start", "end"]);
    expect(recs.filter((r) => r.phase === "start").map((r) => r.stdin)).toEqual(["A", "B", "C"]);
  });
});

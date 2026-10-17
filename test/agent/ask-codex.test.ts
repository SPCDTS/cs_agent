import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCodexEnv,
  buildCodexPrompt,
  CodexRunner,
  CodexTimeoutError,
  ensureWorkspaceAgentsMd,
  extractThreadId,
  isMissingSessionError,
  qqAccessArgs,
  WORKSPACE_AGENTS_MD,
} from "../../src/agent/tools/ask-codex.js";
import { FIXTURES, tmp } from "./helpers.js";

/** 与 setup() 相同的 runner 参数（同一目录，复用日志文件）。 */
function setupOpts(dir: string) {
  return {
    command: [process.execPath, path.join(FIXTURES, "fake-codex.mjs")],
    codexHome: path.join(dir, "codex"),
    workspaceDir: path.join(dir, "ws"),
    sessionFile: path.join(dir, "codex-session.json"),
    sandbox: "workspace-write" as const,
    timeoutMs: 10_000,
    env: { FAKE_CODEX_LOG: path.join(dir, "calls.jsonl"), FAKE_CODEX_THREAD: "thread-fresh" },
  };
}

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

describe("buildCodexEnv", () => {
  it("keeps only the allow-list plus CODEX_HOME and NO_COLOR", () => {
    const env = buildCodexEnv("/data/codex", {
      PATH: "/usr/bin",
      HOME: "/home/node",
      LANG: "C.UTF-8",
      TERM: "xterm",
      HTTPS_PROXY: "http://proxy:3128",
      NAPCAT_TOKEN: "secret",
      OPENAI_API_KEY: "sk-x",
      ANTHROPIC_API_KEY: "sk-y",
      QQ_ALLOW_USERS: "1",
      CODEX_HOME: "/elsewhere",
    });
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/home/node",
      LANG: "C.UTF-8",
      TERM: "xterm",
      HTTPS_PROXY: "http://proxy:3128",
      CODEX_HOME: "/data/codex",
      NO_COLOR: "1",
    });
    for (const k of ["NAPCAT_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "QQ_ALLOW_USERS"]) expect(env[k]).toBeUndefined();
  });
});

describe("isMissingSessionError", () => {
  it("matches confirmed missing-session messages only", () => {
    expect(isMissingSessionError("Error: thread/resume: thread/resume failed: no rollout found for thread id x")).toBe(true);
    expect(isMissingSessionError("Error: session not found")).toBe(true);
    expect(isMissingSessionError("stream disconnected before completion")).toBe(false);
    expect(isMissingSessionError("401 Unauthorized")).toBe(false);
  });
});

describe("ensureWorkspaceAgentsMd", () => {
  it("writes AGENTS.md once and never overwrites operator edits", async () => {
    const dir = path.join(tmp(), "ws");
    expect(await ensureWorkspaceAgentsMd(dir)).toBe(true);
    expect(readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toBe(WORKSPACE_AGENTS_MD);
    expect(WORKSPACE_AGENTS_MD).toMatch(/auth\.json/);
    writeFileSync(path.join(dir, "AGENTS.md"), "custom");
    expect(await ensureWorkspaceAgentsMd(dir)).toBe(false);
    expect(readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toBe("custom");
  });
});

describe("CodexRunner", () => {
  const saved = { NAPCAT_TOKEN: process.env.NAPCAT_TOKEN, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("child process does not inherit secrets from the parent env", async () => {
    process.env.NAPCAT_TOKEN = "napcat-secret";
    process.env.OPENAI_API_KEY = "sk-secret";
    const { runner, calls } = setup();
    await runner.ask("hi");
    const env = calls()[0].env as Record<string, string>;
    expect(env.NAPCAT_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.NO_COLOR).toBe("1");
    expect(JSON.stringify(env)).not.toContain("secret");
  });

  it("persists thread id as soon as thread.started arrives, even if the turn then times out", async () => {
    const { dir, runner } = setup({ sleepMs: 20_000, timeoutMs: 1500, thread: "thread-early" });
    const sessionFile = path.join(dir, "codex-session.json");
    const pending = runner.ask("slow");
    const t0 = Date.now();
    while (!existsSync(sessionFile) && Date.now() - t0 < 1400) await new Promise((r) => setTimeout(r, 20));
    expect(JSON.parse(readFileSync(sessionFile, "utf8")).thread_id).toBe("thread-early"); // 进程仍在运行
    await expect(pending).rejects.toBeInstanceOf(CodexTimeoutError);
    expect(JSON.parse(readFileSync(sessionFile, "utf8")).thread_id).toBe("thread-early");
  });

  it("resume failure that is not a missing session keeps the saved id and returns an error", async () => {
    const { dir, runner, calls } = setup({ thread: "thread-new" });
    const sessionFile = path.join(dir, "codex-session.json");
    writeFileSync(sessionFile, JSON.stringify({ thread_id: "flaky-1" }));
    await expect(runner.ask("again")).rejects.toThrow(/codex 执行失败/);
    expect(calls().filter((c) => c.phase === "start")).toHaveLength(1);
    expect(JSON.parse(readFileSync(sessionFile, "utf8")).thread_id).toBe("flaky-1");
  });

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

  it("passes the chosen reasoning effort as a per-call -c override on first turn and on resume", async () => {
    const { runner, calls } = setup();
    await runner.ask("one", { reasoningEffort: "low" });
    await runner.ask("two", { reasoningEffort: "xhigh" });
    const [first, second] = calls().filter((c) => c.phase === "start");
    const effortOf = (argv: string[]) => argv[argv.findIndex((a, i) => a === "-c" && argv[i + 1]?.startsWith("model_reasoning_effort=")) + 1];
    expect(first.argv[1]).toBe("--json");
    expect(effortOf(first.argv)).toBe('model_reasoning_effort="low"');
    expect(second.argv.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(effortOf(second.argv)).toBe('model_reasoning_effort="xhigh"');
    expect(second.argv.slice(-2)).toEqual(["thread-123", "-"]);
  });

  it("omits the override when no effort is given and rejects unknown efforts", async () => {
    const { runner, calls } = setup();
    await runner.ask("plain");
    expect(calls()[0].argv.join(" ")).not.toContain("model_reasoning_effort");
    await expect(runner.ask("x", { reasoningEffort: "ultra" as never })).rejects.toThrow(/不支持的推理强度/);
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

describe("qq_context access override and §3.2 header", () => {
  it("qqAccessArgs validates and formats the per-call -c override", () => {
    expect(qqAccessArgs(undefined)).toEqual([]);
    expect(qqAccessArgs("group:200000001")).toEqual(["-c", 'mcp_servers.qq_context.env.QQ_ACCESS="group:200000001"']);
    expect(qqAccessArgs("all")).toEqual(["-c", 'mcp_servers.qq_context.env.QQ_ACCESS="all"']);
    expect(() => qqAccessArgs('group:1" ; x')).toThrow(/非法的 QQ_ACCESS/);
  });

  it("buildCodexPrompt: source line, optional quote line (≤200 chars), then body", () => {
    const t = Math.floor(new Date(2026, 9, 17, 22, 41).getTime() / 1000);
    const g = buildCodexPrompt({ type: "group", user_id: "20001", group_id: "200000001", nickname: "De" }, "今晚有cs比赛吗", {
      time: t,
      quote: { nickname: "小明", text: "长".repeat(300) },
    });
    const lines = g.split("\n");
    expect(lines[0]).toBe("[来源] 群 200000001 · De(20001) · 2026-10-17 22:41");
    expect(lines[1]!.startsWith("[引用] 小明: 长")).toBe(true);
    expect(lines[1]!.length).toBeLessThanOrEqual("[引用] 小明: ".length + 200);
    expect(lines[2]).toBe("今晚有cs比赛吗");
    const p = buildCodexPrompt({ type: "private", user_id: "10000001", group_id: null, nickname: "" }, "hi", { time: t });
    expect(p).toBe("[来源] 私聊 · 10000001 · 2026-10-17 22:41\nhi");
  });

  it("passes the QQ_ACCESS override on first turn and on resume", async () => {
    const { runner, calls } = setup();
    await runner.ask("one", { qqAccess: "group:200000001" });
    await runner.ask("two", { qqAccess: "all" });
    const [a, b] = calls().filter((c) => c.phase === "start");
    expect(a.argv).toEqual(expect.arrayContaining(["-c", 'mcp_servers.qq_context.env.QQ_ACCESS="group:200000001"']));
    expect(b.argv.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(b.argv).toEqual(expect.arrayContaining(["-c", 'mcp_servers.qq_context.env.QQ_ACCESS="all"']));
  });
});

describe("single-thread safety valve", () => {
  it("rotates to a new thread when the rollout file exceeds the size limit", async () => {
    const { dir, calls } = setup({ thread: "thread-fresh" });
    const runner = new CodexRunner({ ...setupOpts(dir), rolloutMaxMb: 0.001 });
    writeFileSync(path.join(dir, "codex-session.json"), JSON.stringify({ thread_id: "thread-big", created_at: new Date().toISOString() }));
    const day = path.join(dir, "codex", "sessions", "2026", "10", "17");
    mkdirSync(day, { recursive: true });
    writeFileSync(path.join(day, "rollout-2026-10-17T00-00-00-thread-big.jsonl"), "x".repeat(4096));
    expect(await runner.rolloutSize("thread-big")).toBe(4096);
    await runner.ask("hi");
    const starts = calls().filter((c) => c.phase === "start");
    expect(starts).toHaveLength(1);
    expect(starts[0].argv[1]).toBe("--json"); // 新建而非 resume
    expect(JSON.parse(readFileSync(path.join(dir, "codex-session.json"), "utf8")).thread_id).toBe("thread-fresh");
  });

  it("rotates when the thread is older than the age limit; keeps resuming otherwise", async () => {
    const { dir, calls } = setup({ thread: "thread-fresh" });
    const runner = new CodexRunner({ ...setupOpts(dir), threadMaxDays: 90 });
    const old = new Date(Date.now() - 91 * 86400_000).toISOString();
    writeFileSync(path.join(dir, "codex-session.json"), JSON.stringify({ thread_id: "thread-old", updated_at: old }));
    await runner.ask("a");
    await runner.ask("b");
    const starts = calls().filter((c) => c.phase === "start");
    expect(starts.map((s) => s.argv[1])).toEqual(["--json", "resume"]);
    expect(starts[1].argv.slice(-2)).toEqual(["thread-fresh", "-"]);
    const saved = JSON.parse(readFileSync(path.join(dir, "codex-session.json"), "utf8"));
    expect(Date.parse(saved.created_at)).toBeGreaterThan(Date.now() - 60_000);
  });
});

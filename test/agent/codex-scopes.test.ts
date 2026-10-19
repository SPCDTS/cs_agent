import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexRunner, isThreadKey } from "../../src/agent/codex/runner.js";
import { type ThreadKey } from "../../src/agent/backends/types.js";
import { codexWorkspacePolicy, prepareCodexWorkspace } from "../../src/agent/codex/workspace.js";
import { ContextUsageStore } from "../../src/agent/context-usage.js";
import { CodexBackend } from "../../src/agent/backends/codex.js";
import { FIXTURES, tmp } from "./helpers.js";

function rig() {
  const dir = tmp(), threadsFile = path.join(dir, "codex-threads.json");
  const options = { command: [process.execPath, path.join(FIXTURES, "fake-codex.mjs")],
    codexHome: path.join(dir, "codex"), workspaceDir: path.join(dir, "ws"), threadsFile,
    sandbox: "workspace-write" as const, timeoutMs: 5000,
    env: { FAKE_CODEX_LOG: path.join(dir, "calls.jsonl"), FAKE_CODEX_SLEEP_MS: "80" } };
  const calls = async () => (await fs.readFile(options.env.FAKE_CODEX_LOG, "utf8")).trim().split("\n")
    .map(line => JSON.parse(line)).filter(row => row.phase === "start");
  return { dir, options, threadsFile, calls };
}

describe("按会话域隔离 codex", () => {
  it("键校验拒绝 shared、空来源、路径和非法 QQ 号", async () => {
    const { options } = rig();
    const runner = new CodexRunner(options);
    for (const key of ["shared", "group:0", "private:01", "group:../owner", "group:1/2", "__proto__", "", undefined]) {
      expect(isThreadKey(key)).toBe(false);
      await expect(runner.ask("拒绝", { threadKey: key as ThreadKey })).rejects.toThrow(/线程键/);
      await expect(runner.resetThread(key as ThreadKey)).rejects.toThrow(/线程键/);
    }
    for (const key of ["owner", "group:1", "private:99999999999999999999"]) expect(isThreadKey(key)).toBe(true);
  });

  it("启动先归档 shared，重启和归档后崩溃重试均不重用或重复归档", async () => {
    const { dir, options, threadsFile } = rig();
    const record = { thread_id: "mixed", created_at: "2026-10-18T00:00:00Z" };
    const old = { shared: record, owner: { thread_id: "owner-only" }, "group:7": { thread_id: "group-only" } };
    const store = new ContextUsageStore(dir);
    store.recordTurn("codex", "shared", { usedTokens: 10, windowTokens: 100 });
    await fs.writeFile(threadsFile, JSON.stringify(old), "utf8");
    const runner = new CodexRunner({ ...options, contextUsage: store });
    await runner.initializeContextUsage();
    expect(await runner.readThreadIds()).toEqual({ owner: "owner-only", "group:7": "group-only" });
    const archive = path.join(dir, "codex-threads-archive.jsonl");
    expect((await fs.readFile(archive, "utf8")).trim().split("\n").map(JSON.parse as (line: string) => unknown))
      .toEqual([expect.objectContaining({ key: "shared", ...record, reason: "scope-split" })]);
    expect(JSON.parse(await fs.readFile(threadsFile, "utf8"))).not.toHaveProperty("shared");
    expect(store.get("codex", "shared")).toBeUndefined();
    await fs.writeFile(threadsFile, JSON.stringify(old), "utf8"); // 模拟已归档、映射尚未删除时崩溃。
    expect(await new CodexRunner(options).readThreadIds()).toEqual(await runner.readThreadIds());
    expect((await fs.readFile(archive, "utf8")).trim().split("\n")).toHaveLength(1);
    await store.close();
    expect(new ContextUsageStore(dir).get("codex", "shared")).toBeUndefined();
  });

  it("归档失败就拒绝迁移，不删除 shared 或启动任何会话", async () => {
    const { dir, options, threadsFile } = rig();
    await fs.writeFile(threadsFile, JSON.stringify({ shared: { thread_id: "mixed" } }), "utf8");
    await fs.writeFile(path.join(dir, "codex-threads-archive.jsonl"), "损坏的归档", "utf8");
    const runner = new CodexRunner(options);
    await expect(runner.ask("不能执行", { threadKey: "private:9" })).rejects.toThrow();
    expect(JSON.parse(await fs.readFile(threadsFile, "utf8")).shared.thread_id).toBe("mixed");
    await expect(fs.access(options.env.FAKE_CODEX_LOG)).rejects.toThrow();
  });

  it("群和私聊各自恢复、重置与回填；空闲和失败队列被清理", async () => {
    const { options, calls, threadsFile, dir } = rig();
    await fs.writeFile(threadsFile, JSON.stringify({ "group:7": { thread_id: "group-a" }, "group:8": { thread_id: "group-b" },
      "private:9": { thread_id: "private-c" } }), "utf8");
    const store = new ContextUsageStore(dir);
    const runner = new CodexRunner({ ...options, contextUsage: store });
    await runner.initializeContextUsage();
    expect(store.all().map(row => row.key).sort()).toEqual(["group:7", "group:8", "private:9"]);
    await Promise.all([runner.ask("群 A 的私密标记", { threadKey: "group:7" }),
      runner.ask("群 B 的问题", { threadKey: "group:8" }), runner.ask("私聊问题", { threadKey: "private:9" })]);
    const rows = await calls();
    expect(new Set(rows.map(row => row.argv.at(-2)))).toEqual(new Set(["group-a", "group-b", "private-c"]));
    expect(rows.find(row => row.argv.at(-2) === "group-b").stdin).not.toContain("群 A");
    const queueSize = () => (runner as unknown as { queues: Map<string, unknown> }).queues.size;
    expect(queueSize()).toBe(0);
    await expect(runner.ask("失败", { threadKey: "group:7", onAcquired: async () => { throw Error("fail"); } })).rejects.toThrow("fail");
    expect(queueSize()).toBe(0);
    await runner.resetThread("private:9");
    expect(await new CodexRunner(options).readThreadIds()).toEqual({ "group:7": "group-a", "group:8": "group-b" });
    expect(store.get("codex", "private:9")?.turns).toBe(0);
    await store.close();
  });

  it("新建和 resume 使用同一 scope 工作区，按实际权限注入规则与父目录 AGENTS.md", async () => {
    const { options, calls } = rig();
    await fs.mkdir(options.workspaceDir, { recursive: true });
    await fs.writeFile(path.join(options.workspaceDir, "AGENTS.md"), "运维自定义中文指引", "utf8");
    const runner = new CodexRunner(options);
    await Promise.all([runner.ask("owner", { threadKey: "owner" }), runner.ask("群", { threadKey: "group:42" })]);
    await runner.ask("继续", { threadKey: "group:42" });
    for (const row of await calls()) {
      const owner = row.stdin === "owner", ws = path.join(options.workspaceDir, owner ? "owner" : "group_42");
      expect(row.cwd).toBe(ws);
      expect(row.argv[row.argv.indexOf("-C") + 1]).toBe(ws);
      expect(row.argv).not.toContain("-s");
      expect(row.argv.some((arg: string) => arg.startsWith("sandbox_mode="))).toBe(false);
      const roots = JSON.parse(row.argv.find((arg: string) => arg.startsWith("sandbox_workspace_write.writable_roots=")).split("=")[1]);
      expect(roots).toEqual(owner ? [ws, path.join(path.dirname(options.threadsFile), "prompts")] : [ws]);
      const permissions = row.argv.find((arg: string) => arg.startsWith("permissions.cs_agent_scope="));
      for (const root of roots) expect(permissions).toContain(`${JSON.stringify(root)}="write"`);
      expect(permissions).not.toContain(JSON.stringify(path.join(path.dirname(options.threadsFile), "workflows")));
      expect(row.argv.some((arg: string) => arg.startsWith("developer_instructions="))).toBe(false);
      expect(row.argv).toContain("project_doc_max_bytes=131072");
      const rules = row.workspaceAgentsMd;
      expect(await fs.readFile(path.join(ws, "AGENTS.md"), "utf8")).toBe(rules);
      expect(rules).toContain("运维自定义中文指引");
      expect(rules).toContain(ws);
      expect(rules).not.toContain("workflows");
      if (!owner) expect(rules).not.toContain(path.join(path.dirname(options.threadsFile), "prompts"));
    }
  });

  it("启动按所有动态键读取 rollout 用量，清零已经移除的会话", async () => {
    const { options, dir, threadsFile } = rig();
    const store = new ContextUsageStore(dir);
    store.recordTurn("codex", "private:10", { usedTokens: 20, windowTokens: 500000 });
    const sessions = path.join(options.codexHome, "sessions");
    await fs.mkdir(sessions, { recursive: true });
    await fs.copyFile(path.join(FIXTURES, "context-rollout.jsonl"), path.join(sessions, "rollout-a.jsonl"));
    await fs.copyFile(path.join(FIXTURES, "context-rollout.jsonl"), path.join(sessions, "rollout-b.jsonl"));
    await fs.writeFile(threadsFile, JSON.stringify({ "group:7": { thread_id: "a" }, "private:9": { thread_id: "b" } }), "utf8");
    await new CodexRunner({ ...options, contextUsage: store }).initializeContextUsage();
    for (const key of ["group:7", "private:9"]) expect(store.get("codex", key)).toMatchObject({ usedTokens: 321, cachedTokens: 123, turns: 2, source: "turn" });
    expect(store.get("codex", "private:10")).toMatchObject({ usedTokens: 0, turns: 0 });
    await store.close();
  });

  it("后端保留群与私聊动态键", async () => {
    const dir = tmp(), keys: string[] = [];
    const backend = new CodexBackend({ imagesDir: path.join(dir, "images"), ticketsDir: path.join(dir, "tickets"),
      runner: { ask: async (_prompt, options) => { keys.push(options.threadKey); return "答复"; } } });
    for (const key of ["group:7", "private:9"] as const) await backend.handle({ ticket: key.replace(":", "_"), scope: key, access: key,
      threadKey: key, text: "问题", source: { type: key.startsWith("group") ? "group" : "private", group_id: "7", user_id: "9", nickname: "测试" } },
    { signal: new AbortController().signal, onEvent: () => undefined });
    expect(keys).toEqual(["group:7", "private:9"]);
  });
});

describe("scope 工作区权限", () => {
  it.each(["owner", "group:1", "private:1"])("%s 只读会话不宣称可写；禁止关闭沙箱或把数据目录放在 workspace 内", key => {
    const root = tmp();
    const policy = codexWorkspacePolicy(path.join(root, "ws"), path.join(root, "data"), key, "read-only", false);
    expect(policy.writableRoots).toEqual([]);
    expect(policy.args.join(" ")).not.toContain('="write"');
    expect(policy.args.join(" ")).toContain("enabled=false");
    expect(() => codexWorkspacePolicy(root, root, "owner", "workspace-write")).toThrow();
    expect(() => codexWorkspacePolicy(path.join(root, "ws"), root, "owner", "danger-full-access")).toThrow();
  });

  it("拒绝链接工作区，不跟随工作区指引的符号链接", async () => {
    const root = tmp(), ws = path.join(root, "ws"), external = path.join(root, "external");
    await fs.mkdir(ws); await fs.mkdir(external);
    await fs.symlink(external, path.join(ws, "group_1"), "junction");
    await expect(prepareCodexWorkspace(ws, path.join(ws, "group_1"))).rejects.toThrow(/链接/);
  });
});

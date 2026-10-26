import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexRunner, isThreadKey } from "../../src/agent/codex/runner.js";
import { type ThreadKey } from "../../src/agent/backends/types.js";
import { codexWorkspacePolicy, prepareCodexWorkspace } from "../../src/agent/codex/workspace.js";
import { ContextUsageStore } from "../../src/agent/context-usage.js";
import { codexRunnerRig } from "./codex-fixture.js";
import { FIXTURES, tmp } from "./helpers.js";

const rigs: { close(): Promise<void> }[] = [];
afterEach(async () => { for (const r of rigs.splice(0)) await r.close(); });
const mcpEnv = { im: { IM_TOKEN: "f".repeat(64) } };

/** 线程映射与回填只读文件，不需要 app-server；加载线程用 codexRunnerRig。 */
function rig() {
  const dir = tmp(), threadsFile = path.join(dir, "codex-threads.json");
  const options = { command: [process.execPath, path.join(FIXTURES, "fake-codex.mjs")],
    codexHome: path.join(dir, "codex"), workspaceDir: path.join(dir, "ws"), threadsFile,
    sandbox: "workspace-write" as const };
  return { dir, options, threadsFile };
}
async function live(dir: string, extra: Parameters<typeof codexRunnerRig>[0] = {}) {
  const r = await codexRunnerRig({ dir, ...extra });
  rigs.push(r);
  return r;
}

describe("按会话域隔离 codex", () => {
  it("键校验拒绝 shared、空来源、路径和非法 QQ 号", async () => {
    const { runner } = await live(tmp());
    for (const key of ["shared", "group:0", "private:01", "group:../owner", "group:1/2", "__proto__", "", undefined]) {
      expect(isThreadKey(key)).toBe(false);
      await expect(runner.openThread(key as ThreadKey, { mcpEnv })).rejects.toThrow(/线程键/);
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
    const { runner, requests } = await live(dir, { threadsFile: options.threadsFile });
    await expect(runner.openThread("private:9", { mcpEnv })).rejects.toThrow();
    expect(JSON.parse(await fs.readFile(threadsFile, "utf8")).shared.thread_id).toBe("mixed");
    expect(requests("thread/start")).toHaveLength(0);
  });

  it("群和私聊各自恢复（各自工作区）、重置与回填", async () => {
    const { options, threadsFile, dir } = rig();
    await fs.writeFile(threadsFile, JSON.stringify({ "group:7": { thread_id: "group-a" }, "group:8": { thread_id: "group-b" },
      "private:9": { thread_id: "private-c" } }), "utf8");
    const store = new ContextUsageStore(dir);
    const { runner, loads } = await live(dir, { contextUsage: store });
    await runner.initializeContextUsage();
    expect(store.all().map(row => row.key).sort()).toEqual(["group:7", "group:8", "private:9"]);
    await Promise.all((["group:7", "group:8", "private:9"] as const).map(key => runner.openThread(key, { mcpEnv })));
    expect(new Map(loads().map(l => [l.threadId, path.basename(l.cwd)]))).toEqual(new Map([["group-a", "group_7"], ["group-b", "group_8"], ["private-c", "private_9"]]));
    await runner.resetThread("private:9");
    expect(await new CodexRunner(options).readThreadIds()).toEqual({ "group:7": "group-a", "group:8": "group-b" });
    expect(store.get("codex", "private:9")?.turns).toBe(0);
    await store.close();
  });

  it("新建和 resume 使用同一 scope 工作区，按实际权限注入规则与父目录 AGENTS.md", async () => {
    const { dir, options } = rig();
    await fs.mkdir(options.workspaceDir, { recursive: true });
    await fs.writeFile(path.join(options.workspaceDir, "AGENTS.md"), "运维自定义中文指引", "utf8");
    const { runner, loads } = await live(dir);
    await Promise.all([runner.openThread("owner", { mcpEnv }), runner.openThread("group:42", { mcpEnv })]);
    await runner.openThread("group:42", { mcpEnv });
    expect(loads()).toHaveLength(3);
    for (const row of loads()) {
      const owner = row.cwd.endsWith("owner"), ws = path.join(options.workspaceDir, owner ? "owner" : "group_42");
      expect(row.cwd).toBe(ws);
      expect(row.sandbox).toBeUndefined();
      expect(row.config).not.toHaveProperty("sandbox_mode");
      const roots = row.config["sandbox_workspace_write.writable_roots"] as string[];
      expect(roots).toEqual(owner ? [ws, path.join(path.dirname(options.threadsFile), "prompts")] : [ws]);
      const permissions = row.config["permissions.cs_agent_scope"] as { filesystem: Record<string, string> };
      for (const root of roots) expect(permissions.filesystem[root]).toBe("write");
      expect(permissions.filesystem).not.toHaveProperty(path.join(path.dirname(options.threadsFile), "workflows"));
      expect(row).not.toHaveProperty("developerInstructions");
      expect(row.config.project_doc_max_bytes).toBe(131072);
      const rules = await fs.readFile(path.join(ws, "AGENTS.md"), "utf8");
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
});

describe("scope 工作区权限", () => {
  it("共享技能目录在任何线程都不可写；prompts 只对 owner 线程开放", () => {
    const root = tmp(), data = path.join(root, "data"), codexHome = path.join(root, "custom-codex");
    const skills = path.join(codexHome, "skills", "shared");
    for (const key of ["owner", "group:7", "private:8"]) {
      const policy = codexWorkspacePolicy(path.join(root, "ws"), data, key, "workspace-write", true, codexHome);
      expect(policy.writableRoots).not.toContain(skills);
      expect(policy.args.join(" ")).not.toContain(`${JSON.stringify(skills)}="write"`);
      expect(policy.writableRoots.includes(path.join(data, "prompts"))).toBe(key === "owner");
      expect(codexWorkspacePolicy(path.join(root, "ws"), data, key, "read-only", true, codexHome).writableRoots).toEqual([]);
    }
  });
  it("常驻线程的受管规则：各线程都不能直接写共享技能，规则指向 skill_publish", async () => {
    const { dir, options } = rig();
    const { runner, loads } = await live(dir);
    await runner.openThread("owner", { mcpEnv });
    await runner.openThread("group:7", { mcpEnv });
    const skills = path.join(options.codexHome, "skills", "shared");
    for (const row of loads()) expect(row.config["sandbox_workspace_write.writable_roots"]).not.toContain(skills);
    for (const ws of ["owner", "group_7"]) expect(await fs.readFile(path.join(options.workspaceDir, ws, "AGENTS.md"), "utf8")).toContain("skill_publish");
    expect(loads()[1]!.config["sandbox_workspace_write.writable_roots"]).not.toContain(path.join(path.dirname(options.threadsFile), "prompts"));
  });
  it("记忆段（画像与未完成承诺）随加载线程写进会话域 AGENTS.md；内容不变不重写，读不到不阻塞加载", async () => {
    const { dir, options } = rig();
    const sections: Record<string, string | undefined> = { owner: '<memory ns="owner" profile_revision="none">\n未完成的承诺：\n- #1 周报\n</memory>' };
    const { runner } = await live(dir, { memoryPrompt: async key => {
      if (key === "private:9") throw new Error("坏了");
      return sections[key];
    } });
    const file = (ws: string) => path.join(options.workspaceDir, ws, "AGENTS.md");
    await runner.openThread("owner", { mcpEnv });
    const first = await fs.readFile(file("owner"), "utf8");
    expect(first).toContain("## 记忆（画像与未完成的承诺）\n" + sections.owner);
    const { mtimeMs } = await fs.stat(file("owner"));
    await runner.openThread("owner", { mcpEnv });
    expect((await fs.stat(file("owner"))).mtimeMs).toBe(mtimeMs);
    await runner.openThread("group:7", { mcpEnv });
    expect(await fs.readFile(file("group_7"), "utf8")).not.toContain("<memory");
    await runner.openThread("private:9", { mcpEnv });
    expect(await fs.readFile(file("private_9"), "utf8")).not.toContain("<memory");
  });
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

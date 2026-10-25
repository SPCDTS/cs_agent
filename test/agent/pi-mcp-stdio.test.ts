import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpConnection } from "../../src/agent/pi-mcp/connection.js";
import { DEFAULT_MCP_LIMITS, type McpServerConfig } from "../../src/agent/pi-mcp/config.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const live = () => new AbortController().signal;
const fixture = fileURLToPath(new URL("./fixtures/pi-mcp-stdio.mjs", import.meta.url));

async function rig(mode = "normal", extraArgs: string[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "pi-mcp-stdio-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const metadata = join(directory, "processes.json");
  const server: McpServerConfig = {
    id: "fixture", enabled: true,
    transport: { kind: "stdio", command: process.execPath, args: [fixture, mode, ...extraArgs], cwd: "${sessionWorkspace}", inheritEnv: process.platform === "win32" ? ["SystemRoot"] : [],
      env: { PI_MCP_META: metadata, PLAIN: "ordinary" }, secretEnv: { SECRET: "TEST_SECRET_REF" }, execution: "trusted-host" },
    credential: { kind: "none" }, tools: { allow: ["env"] }, access: { kind: "owner-private", allowScheduled: false, allowWake: false }, replay: "unsafe",
  };
  let changed = 0;
  const open = () => McpConnection.open({ server, limits: { ...DEFAULT_MCP_LIMITS, messageBytes: 2048, connectMs: 10000, closePerConnectionMs: 1000 },
    secrets: { readReferencedVariable: () => "secret-only-reference" }, workspaceDir: directory, signal: live(), onToolsChanged: () => changed++ });
  const pids = async () => z.object({ pid: z.number(), grandchild: z.number().optional() }).parse(JSON.parse(await readFile(metadata, "utf8")));
  return { open, pids, directory, get changed() { return changed; } };
}

function running(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe("Pi MCP 真实 stdio 与进程树", () => {
  it("环境严格白名单、秘密只读引用、工作目录与参数按数据传入", async () => {
    process.env.PI_MCP_UNLISTED_SECRET = "must-not-inherit";
    const fixture = await rig("normal", ["space argument", "中文参数", "literal;echo bad", "${sessionWorkspace}"]);
    const connection = await fixture.open(); cleanup.push(() => connection.close());
    expect((await connection.listTools(live())).map(tool => tool.name)).toEqual(["env"]);
    const result = await connection.callTool("env", {}, live());
    const text = result.content.find(content => content.type === "text");
    if (!text || text.type !== "text") throw new Error("fixture_text");
    const value: unknown = JSON.parse(text.text);
    expect(value).toMatchObject({ env: { SECRET: "secret-only-reference", PLAIN: "ordinary" }, argv: ["space argument", "中文参数", "literal;echo bad", fixture.directory], cwd: fixture.directory });
    expect(text.text).not.toContain("must-not-inherit");
    expect(text.text).not.toContain("PSModulePath");
    expect(fixture.changed).toBe(1);
    delete process.env.PI_MCP_UNLISTED_SECRET;
  });

  it("无换行超大帧在 JSON 解析前终止连接", async () => {
    const fixture = await rig("oversized");
    const connection = await fixture.open(); cleanup.push(() => connection.close());
    await expect(connection.callTool("env", {}, live())).rejects.toMatchObject({ code: "message_limit" });
    await connection.close();
    expect(running((await fixture.pids()).pid)).toBe(false);
  });

  it("close 有界幂等，回收拒绝退出的父子进程", async () => {
    const fixture = await rig("tree");
    const connection = await fixture.open(); cleanup.push(() => connection.close());
    const pids = await fixture.pids();
    if (!pids.grandchild) throw new Error("fixture_grandchild");
    const grandchild = pids.grandchild;
    expect(running(pids.pid)).toBe(true);
    expect(running(pids.grandchild)).toBe(true);
    await Promise.all([connection.close(), connection.close()]);
    await expect.poll(() => running(pids.pid)).toBe(false);
    await expect.poll(() => running(grandchild)).toBe(false);
  });

  it("初始化失败也回收整棵进程树", async () => {
    const fixture = await rig("init-fail");
    await expect(fixture.open()).rejects.toMatchObject({ code: "protocol_error" });
    const pids = await fixture.pids();
    if (!pids.grandchild) throw new Error("fixture_grandchild");
    const grandchild = pids.grandchild;
    await expect.poll(() => running(pids.pid)).toBe(false);
    await expect.poll(() => running(grandchild)).toBe(false);
  });

  it("直接子进程提前退出后，仍回收孙进程", async () => {
    const fixture = await rig("parent-exit");
    const connection = await fixture.open(); cleanup.push(() => connection.close());
    const pids = await fixture.pids();
    if (!pids.grandchild) throw new Error("fixture_grandchild");
    const grandchild = pids.grandchild;
    await connection.callTool("env", {}, live());
    await expect.poll(() => running(pids.pid)).toBe(false);
    await expect.poll(() => running(grandchild)).toBe(false);
  });
});

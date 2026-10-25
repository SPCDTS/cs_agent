/** 现有 Linux Node 容器中的真实 stdio 冒烟；不构建镜像、不连接业务服务。 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.includes("/src/agent/pi-mcp/")) {
    const source = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (existsSync(source)) return next(source.href, context);
  }
  return next(specifier, context);
} });
const { McpConnection } = await import("../../../src/agent/pi-mcp/connection.ts");
const { DEFAULT_MCP_LIMITS } = await import("../../../src/agent/pi-mcp/config.ts");
const fixture = fileURLToPath(new URL("./pi-mcp-stdio.mjs", import.meta.url));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function stopped(pid) {
  for (let i = 0; i < 100 && alive(pid); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(alive(pid), false, `process remains: ${pid}`);
}
for (const mode of ["normal", "oversized", "tree", "init-fail", "parent-exit"]) {
  const directory = await mkdtemp(join(tmpdir(), "pi-mcp-linux-"));
  let connection;
  try {
    const metadata = join(directory, "processes.json");
    const server = {
      id: "fixture", enabled: true, transport: { kind: "stdio", command: process.execPath, args: [fixture, mode], cwd: "${sessionWorkspace}", inheritEnv: [],
        env: { PI_MCP_META: metadata }, secretEnv: {}, execution: "trusted-host" },
      credential: { kind: "none" }, tools: { allow: ["env"] }, access: { kind: "owner-private", allowScheduled: false, allowWake: false }, replay: "unsafe",
    };
    const opening = McpConnection.open({ server, limits: { ...DEFAULT_MCP_LIMITS, messageBytes: 2048, closePerConnectionMs: 1000 },
      secrets: { readReferencedVariable: () => undefined }, workspaceDir: directory, signal: new AbortController().signal, onToolsChanged: () => {} });
    if (mode === "init-fail") await assert.rejects(opening, { code: "protocol_error" });
    else {
      connection = await opening;
      assert.equal((await connection.listTools(new AbortController().signal))[0].name, "env");
      if (mode === "oversized") await assert.rejects(connection.callTool("env", {}, new AbortController().signal), { code: "message_limit" });
      else await connection.callTool("env", {}, new AbortController().signal);
    }
    const pids = JSON.parse(await readFile(metadata, "utf8"));
    if (mode === "parent-exit") await stopped(pids.pid);
    await connection?.close();
    await stopped(pids.pid);
    if (pids.grandchild) await stopped(pids.grandchild);
    console.log(`PASS ${mode}`);
  } finally { await connection?.close(); await rm(directory, { recursive: true, force: true }); }
}

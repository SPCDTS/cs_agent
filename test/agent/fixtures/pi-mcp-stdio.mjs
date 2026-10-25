import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "normal";
let grandchild;
if (mode === "tree" || mode === "init-fail" || mode === "parent-exit") {
  grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
}
if (process.env.PI_MCP_META) writeFileSync(process.env.PI_MCP_META, JSON.stringify({ pid: process.pid, grandchild: grandchild?.pid }), "utf8");
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const lines = createInterface({ input: process.stdin });
lines.on("line", line => {
  const request = JSON.parse(line);
  if (!Object.hasOwn(request, "id")) return;
  let result;
  if (request.method === "initialize") {
    if (mode === "init-fail") { process.stdout.write("{bad\n"); return; }
    result = { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "stdio-fixture", version: "1" } };
  } else if (request.method === "tools/list") {
    result = { tools: [{ name: "env", inputSchema: { type: "object" } }] };
  } else if (request.method === "tools/call") {
    if (mode === "oversized") { process.stdout.write("{" + "x".repeat(4096)); return; }
    result = { content: [{ type: "text", text: JSON.stringify({ env: process.env, argv: process.argv.slice(3), cwd: process.cwd() }) }] };
    send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  } else return;
  send({ jsonrpc: "2.0", id: request.id, result });
  if (mode === "parent-exit" && request.method === "tools/call") setTimeout(() => process.exit(0), 30);
});
lines.on("close", () => {
  if (mode !== "tree" && mode !== "init-fail") process.exit(0);
});
if (mode === "tree" || mode === "init-fail") setInterval(() => {}, 1000);

#!/usr/bin/env node
// 浏览器 MCP 安全实测：在镜像内经 `codex app-server`（stdio JSON-RPC）列出并调用 [mcp_servers.browser] 的工具，
// 检查 browser_run_code_unsafe 被 codex 的 enabled_tools 拒绝、file: 被拦截、data: 正常加载。
// 只建线程不发起轮次，不调用模型、不消耗额度。升级 @openai/codex 或 @playwright/mcp 后重跑。
//
// 用法（在仓库根目录，用假的 /data，不要挂真实数据卷）：
//   mkdir -p /tmp/fake/data/codex /tmp/fake/ws && echo FAKE_AUTH_SECRET > /tmp/fake/data/codex/auth.json && chmod -R a+rwX /tmp/fake
//   docker run --rm --security-opt seccomp=./docker/seccomp-codex.json --user node -w /workspace \
//     -v /tmp/fake/data:/data -v /tmp/fake/ws:/workspace -v "$PWD/scripts:/verify:ro" \
//     cs-agent:<tag> node /verify/verify-browser-mcp.mjs
// （Windows Git Bash 前加 MSYS_NO_PATHCONV=1。entrypoint 会先生成受管 config.toml，再执行本脚本。）
//
// 参数：其余 argv 原样传给 `codex app-server`（例如 -c 'mcp_servers.browser.enabled_tools=[...]' 做对比实验）。
// 环境变量：VERIFY_SECRET_FILE（默认 /data/codex/auth.json，应为假凭据）、VERIFY_TIMEOUT_MS（每个请求，默认 90000）。
// 退出码：全部检查通过为 0，否则为 1。输出中假凭据内容一律打码。
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const SECRET_FILE = process.env.VERIFY_SECRET_FILE ?? "/data/codex/auth.json";
const TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS ?? 90000);
let secret = "";
try {
  secret = readFileSync(SECRET_FILE, "utf8").trim();
} catch {
  /* 没有该文件时只做结构检查 */
}
const redact = (s) => (secret ? s.split(secret).join("<SECRET>") : s);

const child = spawn("codex", ["app-server", ...process.argv.slice(2)], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
let stderr = "";
const waiters = new Map();
child.stderr.on("data", (c) => (stderr = (stderr + c).slice(-4000)));
child.stdout.setEncoding("utf8");
child.stdout.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.id !== undefined && waiters.has(m.id)) {
      waiters.get(m.id)(m);
      waiters.delete(m.id);
    }
  }
});
let nextId = 0;
const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = ++nextId;
    const t = setTimeout(() => {
      waiters.delete(id);
      resolve({ error: { message: `timeout: ${method}` } });
    }, TIMEOUT_MS);
    waiters.set(id, (m) => {
      clearTimeout(t);
      resolve(m);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      ${redact(detail).replace(/\s+/g, " ").slice(0, 300)}`);
};
const text = (r) => JSON.stringify(r.error ?? r.result ?? r);

await rpc("initialize", { clientInfo: { name: "verify-browser-mcp", title: "verify-browser-mcp", version: "1" } });
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);
const thread = await rpc("thread/start", { cwd: process.cwd() });
const threadId = thread.result?.thread?.id;
if (!threadId) {
  console.log(`thread/start failed: ${text(thread).slice(0, 300)}\nstderr: ${redact(stderr)}`);
  child.kill();
  process.exit(1);
}

const st = await rpc("mcpServerStatus/list", { serverName: "browser", detail: "toolsAndAuthOnly", threadId });
const server = (st.result?.data ?? []).find((s) => s.name === "browser");
const tools = Object.keys(server?.tools ?? {}).sort();
check("browser MCP is registered and exposes tools", tools.length > 0, `${tools.length} tools: ${tools.join(",")}`);
check("browser_run_code_unsafe is not exposed", !tools.includes("browser_run_code_unsafe"), tools.join(","));
for (const t of ["browser_file_upload", "browser_drop"]) check(`${t} is not exposed`, !tools.includes(t), "");

const call = (tool, args) => rpc("mcpServer/tool/call", { server: "browser", threadId, tool, arguments: args });

const rce = await call("browser_run_code_unsafe", {
  code: `async (page) => { const p = page.constructor.constructor('return process')(); return 'ESC ' + p.mainModule.require('fs').readFileSync(${JSON.stringify(SECRET_FILE)}, 'utf8'); }`,
});
check("calling browser_run_code_unsafe is refused by codex", !!rce.error && !(secret && text(rce).includes(secret)), text(rce));

for (const url of ["file:///etc/hostname", "file:///data/codex/config.toml", `file://${SECRET_FILE}`]) {
  const r = await call("browser_navigate", { url });
  check(`browser_navigate ${url} is blocked`, /protocol is blocked|ERR_BLOCKED|not allowed/i.test(text(r)) && !(secret && text(r).includes(secret)), text(r));
}
const tab = await call("browser_tabs", { action: "new", url: "file:///etc/hostname" });
check("browser_tabs new file: is blocked", /protocol is blocked|ERR_BLOCKED|not allowed/i.test(text(tab)), text(tab));

const ok = await call("browser_navigate", { url: "data:text/html,<h1>verify-ok</h1>" });
check("browser_navigate data: still loads", text(ok).includes("Page URL: data:text/html"), text(ok));

await call("browser_evaluate", { function: `() => { location.href = 'file://${SECRET_FILE}'; return 'set'; }` });
const snap = await call("browser_snapshot", {});
check("page JS cannot navigate to file:", text(snap).includes("verify-ok") && !text(snap).includes("Page URL: file:"), text(snap));
const fetched = await call("browser_evaluate", {
  function: `async () => { try { const r = await fetch('file://${SECRET_FILE}'); return 'FETCHED ' + await r.text(); } catch (e) { return 'fetch error: ' + e.message; } }`,
});
// 只看结果行（工具输出里还会回显代码本身，代码中含 'FETCHED '）
const resultLine = (r) => /### Result\n(.*)/.exec((r.result?.content ?? []).map((c) => c.text ?? "").join("\n"))?.[1] ?? "";
check("page JS cannot fetch file:", resultLine(fetched).startsWith('"fetch error'), resultLine(fetched) || text(fetched));

child.kill();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// 假 codex：记录 argv/stdin 到 FAKE_CODEX_LOG，输出 JSONL，写 -o 文件。
// FAKE_CODEX_IMAGES=N：模拟图片附件/生图，向本轮注入的图片目录写 N 张 PNG 和一个非图片文件。
// FAKE_CODEX_TEXT：覆盖回答正文。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const argv = process.argv.slice(2);
if (argv[0] === "debug" && argv[1] === "models") {
  if (process.env.FAKE_CODEX_CATALOG_LOG) appendFileSync(process.env.FAKE_CODEX_CATALOG_LOG, JSON.stringify({ argv, codexHome: process.env.CODEX_HOME }) + "\n");
  if (process.env.FAKE_CODEX_CATALOG_FAIL) process.exit(1);
  process.stdout.write(process.env.FAKE_CODEX_CATALOG ?? JSON.stringify({ models: [{ slug: "codex/gpt-6.1-sol", context_window: 500000 }] }));
  process.exit(0);
}
const out = argv[argv.indexOf("-o") + 1];
const isResume = argv[0] === "exec" && argv.includes("resume");
const sleepMs = Number(process.env.FAKE_CODEX_SLEEP_MS ?? 0);
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", async () => {
  const log = (rec) => process.env.FAKE_CODEX_LOG && appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(rec) + "\n");
  const start = Date.now();
  const agentsFile = path.join(process.cwd(), "AGENTS.md");
  const workspaceAgentsMd = existsSync(agentsFile) ? readFileSync(agentsFile, "utf8") : null;
  log({ phase: "start", pid: process.pid, argv, stdin, codexHome: process.env.CODEX_HOME, cwd: process.cwd(), workspaceAgentsMd, t: start, env: process.env });
  const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  if (isResume) {
    const id = argv[argv.length - 2];
    if (process.env.FAKE_CODEX_RESUME_ERROR) {
      process.stderr.write(process.env.FAKE_CODEX_RESUME_ERROR);
      process.exit(1);
    }
    if (id.startsWith("missing")) {
      process.stderr.write(`Error: thread/resume: thread/resume failed: no rollout found for thread id ${id}\n`);
      process.exit(1);
    }
    if (id.startsWith("flaky")) {
      process.stderr.write("Error: stream disconnected before completion: error sending request\n");
      process.exit(1);
    }
  } else {
    emit({ type: "thread.started", thread_id: process.env.FAKE_CODEX_THREAD ?? "thread-123" });
  }
  emit({ type: "turn.started" });
  // FAKE_CODEX_TOOL_EVENTS=1：在挂起前发出 MCP 工具与命令的 started 事件，挂起后再发 completed（模拟进行中的回合）
  const tools = process.env.FAKE_CODEX_TOOL_EVENTS === "1";
  const mcp = { id: "call_1", type: "mcp_tool_call", server: "qq_context", tool: "qq_recent", arguments: { limit: 3 } };
  const cmd = { id: "cmd_1", type: "command_execution", command: "ls /workspace" };
  if (tools) { emit({ type: "item.started", item: { ...mcp, status: "in_progress" } }); emit({ type: "item.started", item: { ...cmd, status: "in_progress" } }); }
  if (sleepMs) await new Promise((r) => setTimeout(r, sleepMs));
  if (tools) { emit({ type: "item.completed", item: { ...cmd, status: "completed", exit_code: 0 } }); emit({ type: "item.completed", item: { ...mcp, status: "completed", result: { content: [] } } }); }
  const images = Number(process.env.FAKE_CODEX_IMAGES ?? 0);
  const attachArg = argv.find(a => a.startsWith("mcp_servers.qq_context.env.QQ_ATTACH_DIR=") && !a.endsWith('=""'));
  const dirArg = attachArg || argv.find((a) => a.startsWith("mcp_servers.image_gen.env.IMAGE_TICKET_DIR="));
  if (images && dirArg) {
    const raw = dirArg.slice(dirArg.indexOf("=") + 1);
    const dir = attachArg ? JSON.parse(raw) : raw.replace(/^"|"$/g, "");
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < images; i++) writeFileSync(path.join(dir, `img_${i}.png`), PNG);
    writeFileSync(path.join(dir, "notes.txt"), "not an image file");
  }
  const text = process.env.FAKE_CODEX_TEXT ?? `answer to: ${stdin.trim().split("\n").pop()}`;
  emit({ type: "item.completed", item: { id: "item_1", type: "agent_message", text } });
  if (process.env.FAKE_CODEX_NO_COMPLETED !== "1") emit({ type: "turn.completed", usage: JSON.parse(process.env.FAKE_CODEX_USAGE ?? "{}") });
  if (process.env.FAKE_CODEX_NO_OUT !== "1") writeFileSync(out, text);
  // 脱离父进程事件循环但继续持有输出管道；POSIX 保留 runner 的进程组以覆盖生产中的 killTree。
  if (process.env.FAKE_CODEX_HOLD_PIPE === "1") {
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => process.stdout.write(process.argv[1]), 100); setTimeout(() => {}, 8000)", process.env.FAKE_CODEX_PIPE_TAIL ?? ""], {
      stdio: ["ignore", process.stdout, process.stderr], detached: process.platform === "win32", windowsHide: true,
    });
    log({ phase: "holder", pid: holder.pid, t: Date.now() });
    holder.unref();
  }
  // FAKE_CODEX_SLEEP_AFTER_OUT_MS：写完 -o 文件后再挂起（模拟回合已完成、进程在结果提交前被杀）
  const after = Number(process.env.FAKE_CODEX_SLEEP_AFTER_OUT_MS ?? 0);
  if (after) await new Promise((r) => setTimeout(r, after));
  // 模拟 turn.completed 已发出，但 rollout 要等进程退出才完成落盘。
  if (process.env.FAKE_CODEX_ROLLOUT_USAGE) process.on("exit", () => {
    const threadId = isResume ? argv[argv.length - 2] : process.env.FAKE_CODEX_THREAD ?? "thread-123";
    const dir = path.join(process.env.CODEX_HOME, "sessions", "2026", "10", "18");
    mkdirSync(dir, { recursive: true });
    const timestamp = new Date().toISOString();
    const usage = JSON.parse(process.env.FAKE_CODEX_ROLLOUT_USAGE);
    const requests = Array.isArray(usage) ? usage : [usage];
    const rows = [
      { type: "task_started" },
      ...requests.map(last_token_usage => ({ type: "token_count", info: { last_token_usage, total_token_usage: JSON.parse(process.env.FAKE_CODEX_USAGE ?? "{}"),
        ...(process.env.FAKE_CODEX_MODEL_CONTEXT_WINDOW ? { model_context_window: Number(process.env.FAKE_CODEX_MODEL_CONTEXT_WINDOW) } : {}) } })),
      { type: "task_complete" },
    ].map(payload => JSON.stringify({ timestamp, type: "event_msg", payload }));
    appendFileSync(path.join(dir, "rollout-" + threadId + ".jsonl"), rows.join("\n") + "\n", "utf8");
  });
  log({ phase: "end", pid: process.pid, t: Date.now() });
  process.exitCode = Number(process.env.FAKE_CODEX_EXIT_CODE ?? 0);
});

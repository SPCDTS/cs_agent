#!/usr/bin/env node
// 假 codex：记录 argv/stdin 到 FAKE_CODEX_LOG，输出 JSONL，写 -o 文件。
// FAKE_CODEX_IMAGES=N：模拟 image_gen MCP，向 -c 注入的 IMAGE_TICKET_DIR 写 N 张 PNG 和一个非图片文件。
// FAKE_CODEX_TEXT：覆盖回答正文。
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const argv = process.argv.slice(2);
const out = argv[argv.indexOf("-o") + 1];
const isResume = argv[0] === "exec" && argv[1] === "resume";
const sleepMs = Number(process.env.FAKE_CODEX_SLEEP_MS ?? 0);
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", async () => {
  const log = (rec) => process.env.FAKE_CODEX_LOG && appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(rec) + "\n");
  const start = Date.now();
  log({ phase: "start", pid: process.pid, argv, stdin, codexHome: process.env.CODEX_HOME, cwd: process.cwd(), t: start, env: process.env });
  const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  if (isResume) {
    const id = argv[argv.length - 2];
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
  if (sleepMs) await new Promise((r) => setTimeout(r, sleepMs));
  const images = Number(process.env.FAKE_CODEX_IMAGES ?? 0);
  const dirArg = argv.find((a) => a.startsWith("mcp_servers.image_gen.env.IMAGE_TICKET_DIR="));
  if (images && dirArg) {
    const dir = dirArg.slice(dirArg.indexOf("=") + 1).replace(/^"|"$/g, "");
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < images; i++) writeFileSync(path.join(dir, `img_${i}.png`), PNG);
    writeFileSync(path.join(dir, "notes.txt"), "not an image file");
  }
  const text = process.env.FAKE_CODEX_TEXT ?? `answer to: ${stdin.trim().split("\n").pop()}`;
  emit({ type: "item.completed", item: { id: "item_1", type: "agent_message", text } });
  emit({ type: "turn.completed", usage: {} });
  writeFileSync(out, text);
  log({ phase: "end", pid: process.pid, t: Date.now() });
});

#!/usr/bin/env node
// 假 codex：记录 argv/stdin 到 FAKE_CODEX_LOG，输出 JSONL，写 -o 文件。
import { appendFileSync, writeFileSync } from "node:fs";

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
  const text = `answer to: ${stdin.trim().split("\n").pop()}`;
  emit({ type: "item.completed", item: { id: "item_1", type: "agent_message", text } });
  emit({ type: "turn.completed", usage: {} });
  writeFileSync(out, text);
  log({ phase: "end", pid: process.pid, t: Date.now() });
});

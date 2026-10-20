// 压缩集成测试桩；正常回合直接复用已有 exec 桩。
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

if (process.argv[2] !== "app-server") {
  await import("./fake-codex.mjs");
} else {
  const log = record => appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(record) + "\n");
  log({ phase: "compact-start", t: Date.now(), argv: process.argv.slice(2), env: process.env,
    config: readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf8") });
  const emit = message => process.stdout.write(JSON.stringify(message) + "\n");
  createInterface({ input: process.stdin }).on("line", line => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    log({ phase: "rpc", method: message.method, params: message.params });
    if (message.method === "thread/compact/start" && process.env.FAKE_COMPACT_FAIL) {
      emit({ id: message.id, error: { code: -32603, message: "fake failure" } });
      return;
    }
    emit({ id: message.id, result: {} });
    if (message.method === "thread/compact/start") {
      emit({ method: "item/completed", params: { threadId: message.params.threadId, turnId: "compact-turn", item: { id: "compact-item", type: "contextCompaction" } } });
    }
  });
}

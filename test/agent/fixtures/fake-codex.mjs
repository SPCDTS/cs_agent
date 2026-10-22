#!/usr/bin/env node
// 假 codex CLI：只实现模型目录查询 `codex debug models`（上下文窗口）。常驻 app-server 在测试中由内存版替代
// （test/agent/codex-app-server/fake-app-server.ts，经 CodexRunner 的 spawn 注入）。
// FAKE_CODEX_CATALOG：覆盖目录 JSON；FAKE_CODEX_CATALOG_FAIL：以非零退出；FAKE_CODEX_CATALOG_LOG：记录调用。
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (argv[0] === "debug" && argv[1] === "models") {
  if (process.env.FAKE_CODEX_CATALOG_LOG) appendFileSync(process.env.FAKE_CODEX_CATALOG_LOG, JSON.stringify({ argv, codexHome: process.env.CODEX_HOME }) + "\n");
  if (process.env.FAKE_CODEX_CATALOG_FAIL) process.exit(1);
  process.stdout.write(process.env.FAKE_CODEX_CATALOG ?? JSON.stringify({ models: [{ slug: "codex/gpt-6.1-sol", context_window: 500000 }] }));
  process.exit(0);
}
process.stderr.write("fake codex: only `debug models` is supported\n");
process.exit(2);

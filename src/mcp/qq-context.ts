#!/usr/bin/env node
/**
 * qq_context MCP 入口（stdio）。由 codex 按受管 config.toml 启动：
 *   command = "node", args = ["/app/dist/mcp/qq-context.js"]
 * 环境：DATA_DIR（库目录，默认 /data）、QQ_ACCESS（group:<id> | private:<qq> | all）、QQ_CONTEXT_MAX_CHARS。
 * stdout 专用于 MCP 协议；诊断写 stderr。
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseAccess } from "../context/access.js";
import { ContextStore } from "../context/store.js";
import { createQQContextServer } from "./qq-context-server.js";

const dataDir = process.env.DATA_DIR || "/data";
const maxChars = Number(process.env.QQ_CONTEXT_MAX_CHARS);
let store: ContextStore | undefined;

const server = createQQContextServer({
  access: parseAccess(process.env.QQ_ACCESS),
  openStore: () => (store ??= new ContextStore(dataDir, { readOnly: true })),
  ...(Number.isInteger(maxChars) && maxChars > 0 ? { maxChars } : {}),
});

const shutdown = () => {
  try {
    store?.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
};
process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.connect(new StdioServerTransport()).catch((err: unknown) => {
  process.stderr.write(`qq_context: ${(err as Error).message}\n`);
  process.exit(1);
});

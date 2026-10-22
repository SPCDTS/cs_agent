#!/usr/bin/env node
/**
 * qq_context MCP 入口（stdio）。由 codex app-server 按线程启动（受管 config.toml 定义命令，线程 config 注入令牌）：
 *   command = "node", args = ["/app/dist/mcp/qq-context.js"]
 * 环境：DATA_DIR（库目录，默认 /data）、QQ_RECALL_TOKEN（线程令牌）、MEDIA_RECALL_PORT、QQ_CONTEXT_MAX_CHARS。
 * 读取范围每次调用向主进程求取（/context）。stdout 专用于 MCP 协议；诊断写 stderr。
 */
import { chatsViaLoopback, contextViaLoopback, recallViaLoopback, viewViaLoopback } from "./media-recall-client.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseAccess } from "../context/access.js";
import { MemoryInstrumentation } from "../obs/memory/instrumentation.js";
import { ContextStore } from "../context/store.js";
import { createQQContextServer } from "./qq-context-server.js";

const dataDir = process.env.DATA_DIR || "/data";
const maxChars = Number(process.env.QQ_CONTEXT_MAX_CHARS);
const token = process.env.QQ_RECALL_TOKEN, port = Number(process.env.MEDIA_RECALL_PORT || 8790);
let store: ContextStore | undefined;
let instrumentation: MemoryInstrumentation | undefined;

const server = createQQContextServer({
  context: async meta => {
    const context = await contextViaLoopback(token, port, meta);
    const access = parseAccess(context.access);
    if (!access) throw new Error("qq_context 不可用：主进程返回的访问范围无效。");
    return { access, turnId: context.turn_id, session: context.session };
  },
  onRecall: (event, context) => {
    (instrumentation ??= MemoryInstrumentation.openOwn(dataDir)).recordRecall({ ...event,
      backend: "codex", turn_id: context.turnId ?? null, session: context.session ?? null });
  },
  chats: meta => chatsViaLoopback(token, port, meta),
  recall: (id, meta) => recallViaLoopback(id, token, port, meta),
  view: (file, meta) => viewViaLoopback(file, token, port, meta),
  openStore: () => (store ??= new ContextStore(dataDir, { readOnly: true })),
  ...(Number.isInteger(maxChars) && maxChars > 0 ? { maxChars } : {}),
});

const shutdown = () => {
  try {
    store?.close();
    instrumentation?.close();
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

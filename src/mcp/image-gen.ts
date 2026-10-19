#!/usr/bin/env node
/**
 * image_gen MCP 入口（stdio）。由 codex 按受管 config.toml 启动：
 *   command = "node", args = ["/app/dist/mcp/image-gen.js"]
 * 环境：DATA_DIR、IMAGE_TICKET_DIR（每轮 -c 注入）、COMFY_*（entrypoint 从容器环境透传，与 agent 主进程同一套配置；
 * mcp 模式经主进程的 127.0.0.1 loopback 转发访问 ComfyUI，见 backendConfigFromEnv）。
 * stdout 专用于 MCP 协议；诊断写 stderr。
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createImageBackend } from "../media/gen/image-gen.js";
import { backendConfigFromEnv, createImageGenServer } from "./image-gen-server.js";
import { parseAccess } from "../context/access.js";
import { loadConfig } from "../config.js";

import { ImageEventSpool } from "../media/gen/events.js";
import { Trace } from "../shared/trace.js";
const { server, dispose } = createImageGenServer({
  observer: dir => new Trace(new ImageEventSpool(dir)),
  ticketDir: process.env.IMAGE_TICKET_DIR,
  imageRefs: process.env.IMAGE_REFS,
  access: parseAccess(process.env.QQ_ACCESS),
  dataDir: process.env.DATA_DIR || "/data",
  waitMs: loadConfig(process.env).IMAGE_GEN_MCP_WAIT_SEC * 1000,
  imageTimeoutCapMs: loadConfig(process.env).COMFY_TIMEOUT_SEC * 1000,
  createBackend: () => createImageBackend(backendConfigFromEnv(process.env)),
});

const shutdown = () => {
  void dispose().finally(() => process.exit(0));
};
process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.connect(new StdioServerTransport()).catch((err: unknown) => {
  process.stderr.write(`image_gen: ${(err as Error).message}\n`);
  process.exit(1);
});

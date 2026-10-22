#!/usr/bin/env node
/**
 * image_gen MCP 入口（stdio）。由 codex app-server 按线程启动（受管 config.toml 定义命令，线程 config 注入令牌）：
 *   command = "node", args = ["/app/dist/mcp/image-gen.js"]
 * 环境：DATA_DIR、IMAGE_GEN_TOKEN（线程令牌）、MEDIA_RECALL_PORT、COMFY_*（entrypoint 从容器环境透传，与 agent 主进程同一套配置；
 * mcp 模式经主进程的 127.0.0.1 loopback 转发访问 ComfyUI，见 backendConfigFromEnv）。
 * 输出目录、参考图与读取范围每次调用向主进程求取（/context）。stdout 专用于 MCP 协议；诊断写 stderr。
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createImageBackend } from "../media/gen/image-gen.js";
import { backendConfigFromEnv, createImageGenServer } from "./image-gen-server.js";
import { parseAccess } from "../context/access.js";
import { loadAgentConfig as loadConfig } from "../agent/config.js";
import { contextViaLoopback } from "./media-recall-client.js";

import { ImageEventSpool } from "../media/gen/events.js";
import { Trace } from "../shared/trace.js";
const token = process.env.IMAGE_GEN_TOKEN, port = Number(process.env.MEDIA_RECALL_PORT || 8790);
const { server, dispose } = createImageGenServer({
  observer: dir => new Trace(new ImageEventSpool(dir)),
  context: async meta => {
    const context = await contextViaLoopback(token, port, meta);
    const access = parseAccess(context.access);
    return { dir: context.image_dir, refs: context.image_refs, turnId: context.turn_id, ...(access ? { access } : {}) };
  },
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

#!/usr/bin/env node
/**
 * im MCP 入口（stdio）。由 codex app-server 按线程启动：IM_TOKEN（线程令牌）与 MEDIA_RECALL_PORT 来自
 * thread/start、thread/resume 的 config（mcp_servers.im.env.*）。
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createImServer, imViaLoopback, sendViaLoopback } from "./im-server.js";

async function main() {
  const token = process.env.IM_TOKEN, port = Number(process.env.MEDIA_RECALL_PORT || 8790);
  const server = createImServer({
    send: (args, meta) => sendViaLoopback(args, meta, token, port),
    auth: (name, args, meta) => imViaLoopback(name, args, meta, token, port),
    skillPublish: (args, meta) => imViaLoopback("skill_publish", args, meta, token, port),
    schedule: async (name, args, meta) => {
      const result = await imViaLoopback(name, args, meta, token, port);
      if (typeof result !== "string") throw new Error("定时工具返回格式错误");
      return result;
    },
  });
  await server.connect(new StdioServerTransport());
}
main().catch((error: unknown) => {
  process.stderr.write(`im: ${(error as Error).message}\n`);
  process.exit(1);
});

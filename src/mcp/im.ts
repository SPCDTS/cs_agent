#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createImServer, imPermissions, imViaLoopback, sendViaLoopback } from "./im-server.js";

async function main() {
  const token = process.env.IM_TOKEN, port = Number(process.env.MEDIA_RECALL_PORT || 8790);
  const server = createImServer(args => sendViaLoopback(args, token, port), {
    permissions: await imPermissions(token, port),
    auth: (name, args) => imViaLoopback(name, args, token, port),
  });
  await server.connect(new StdioServerTransport());
}
main().catch((error: unknown) => {
  process.stderr.write(`im: ${(error as Error).message}\n`);
  process.exit(1);
});

#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createImServer, sendViaLoopback } from "./im-server.js";

const server = createImServer(args => sendViaLoopback(args, process.env.IM_TOKEN, Number(process.env.MEDIA_RECALL_PORT || 8790)));
server.connect(new StdioServerTransport()).catch((error: unknown) => {
  process.stderr.write(`im: ${(error as Error).message}\n`);
  process.exit(1);
});

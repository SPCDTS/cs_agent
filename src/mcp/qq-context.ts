#!/usr/bin/env node
/**
 * qq_context MCP 入口（stdio）。由 codex 按受管 config.toml 启动：
 *   command = "node", args = ["/app/dist/mcp/qq-context.js"]
 * 环境：DATA_DIR（库目录，默认 /data）、QQ_ACCESS（group:<id> | private:<qq> | all）、QQ_CONTEXT_MAX_CHARS。
 * stdout 专用于 MCP 协议；诊断写 stderr。
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import { loadConfig } from "../config.js";
import { resolveAttachmentDir } from "../media/attach-paths.js";
import { recallViaLoopback, viewViaLoopback } from "./media-recall-client.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseAccess } from "../context/access.js";
import { MemoryInstrumentation } from "../obs/memory/instrumentation.js";
import { ContextStore } from "../context/store.js";
import { createQQContextServer } from "./qq-context-server.js";

const dataDir = process.env.DATA_DIR || "/data";
const maxChars = Number(process.env.QQ_CONTEXT_MAX_CHARS);
let store: ContextStore | undefined;
let instrumentation: MemoryInstrumentation | undefined;

const server = createQQContextServer({
  access: parseAccess(process.env.QQ_ACCESS),
  attachments: async () => {
    const cfg = loadConfig();
    const attachDir = await resolveAttachmentDir(process.env.QQ_ATTACH_DIR, path.join(dataDir, "images"), "QQ_ATTACH_DIR");
    const fileDir = await resolveAttachmentDir(process.env.QQ_FILE_DIR, path.join(dataDir, "files"), "QQ_FILE_DIR");
    const workdir = await resolveAttachmentDir(process.env.QQ_WORKDIR, cfg.WORKSPACE_DIR, "QQ_WORKDIR");
    if (path.basename(attachDir) !== path.basename(fileDir)) throw new Error("附件目录票据不一致");
    const extraRoots: string[] = [];
    const session = process.env.QQ_SESSION;
    if (process.env.QQ_BACKEND === "codex" && session?.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session)) {
      const generated = path.join(dataDir, "codex", "generated_images", session);
      const stat = await fs.lstat(generated).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
      if (stat?.isDirectory()) extraRoots.push(generated);
    }
    return { dataDir, attachDir, fileDir, workdir, extraRoots, limits: { maxBytes: cfg.ATTACH_FILE_MAX_MB * 1024 * 1024, maxFiles: cfg.ATTACH_FILES_MAX, denyExtensions: cfg.ATTACH_FILE_DENY_EXT } };
  },
  onRecall: event => {
    (instrumentation ??= MemoryInstrumentation.openOwn(dataDir)).recordRecall({ ...event,
      backend: process.env.QQ_BACKEND || 'codex', ticket: process.env.QQ_TICKET || null,
      session: process.env.QQ_SESSION || null });
  },
  recall: id => recallViaLoopback(id, process.env.QQ_RECALL_TOKEN, Number(process.env.MEDIA_RECALL_PORT || 8790)),
  view: file => viewViaLoopback(file, process.env.QQ_RECALL_TOKEN, Number(process.env.MEDIA_RECALL_PORT || 8790)),
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

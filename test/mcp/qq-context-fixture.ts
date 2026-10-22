/**
 * qq_context MCP 装置：线程令牌端点 + qq_context 服务。缺省在进程内按 src/mcp/qq-context.ts 的接线创建服务
 * （经真实 loopback HTTP 求范围）；stdio=true 时启动构建后的 dist/mcp/qq-context.js 子进程（只在集成项目里用）。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach } from "vitest";
import { parseAccess, type Access } from "../../src/context/access.js";
import type { MediaRecall } from "../../src/context/media.js";
import { ThreadTokens, startMediaRecallServer } from "../../src/context/media-recall-server.js";
import { ContextStore } from "../../src/context/store.js";
import type { Channel, InboundMessage } from "../../src/channel/types.js";
import { chatsViaLoopback, contextViaLoopback, recallViaLoopback, viewViaLoopback } from "../../src/mcp/media-recall-client.js";
import { createQQContextServer } from "../../src/mcp/qq-context-server.js";
import { MemoryInstrumentation } from "../../src/obs/memory/instrumentation.js";
import { callBinding } from "../context/gateway-fixture.js";

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "mcp", "qq-context.js");
export const G = "200000001";
let seq = 1;
export function msg(text: string, o: Partial<InboundMessage> = {}): InboundMessage {
  return {
    message_id: String(seq++), time: Math.floor(Date.now() / 1000), message_type: "group", user_id: "20001",
    group_id: G, self_id: "10001", nickname: "De", text, route_text: text, truncated: false, mentioned_self: false,
    images: [], segments: [{ type: "text", data: { text } }], ...o,
  };
}
export const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content ?? []).map((c) => c.text).join("");
export const scope: Access = { kind: "scope", scope: `group:${G}` };

const closes: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });

/**
 * 读取范围由主进程按会话当前回合求出（这里固定为 access；undefined 表示调用不属于当前回合，网关拒绝）。
 */
export async function connect(dataDir: string, access: Access | undefined,
  extra: { media?: Partial<Pick<MediaRecall, "recall" | "view">>; channel?: Pick<Channel, "listChats">; stdio?: boolean } = {}) {
  const tokens = new ThreadTokens({ recall: async () => ({ text: "ok", images: [] }), ...extra.media }, {
    resolve: async threadKey => {
      if (!access) throw new Error("本回合已结束，工具调用不再有效");
      return callBinding(threadKey, access, { turnId: "codex:mcp-turn", session: "thr-sess" });
    },
    send: async () => ({}),
  }, 5, extra.channel);
  const endpoint = await startMediaRecallServer(tokens, 0);
  closes.push(endpoint.close);
  const token = tokens.issue(`group:${G}`), port = endpoint.port;
  const client = new Client({ name: "test", version: "1.0.0" });
  if (extra.stdio) {
    const env: Record<string, string> = { DATA_DIR: dataDir, PATH: process.env.PATH ?? "", QQ_RECALL_TOKEN: token, MEDIA_RECALL_PORT: String(port) };
    if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [ENTRY], env, stderr: "pipe" }));
  } else {
    // 与 src/mcp/qq-context.ts 相同的接线
    let store: ContextStore | undefined, instrumentation: MemoryInstrumentation | undefined;
    const server = createQQContextServer({
      context: async meta => {
        const context = await contextViaLoopback(token, port, meta);
        const parsed = parseAccess(context.access);
        if (!parsed) throw new Error("qq_context 不可用：主进程返回的访问范围无效。");
        return { access: parsed, turnId: context.turn_id, session: context.session };
      },
      onRecall: (event, context) => {
        (instrumentation ??= MemoryInstrumentation.openOwn(dataDir)).recordRecall({ ...event,
          backend: "codex", turn_id: context.turnId ?? null, session: context.session ?? null });
      },
      chats: meta => chatsViaLoopback(token, port, meta),
      recall: (id, meta) => recallViaLoopback(id, token, port, meta),
      view: (file, meta) => viewViaLoopback(file, token, port, meta),
      openStore: () => (store ??= new ContextStore(dataDir, { readOnly: true })),
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    await client.connect(clientSide);
    closes.push(() => { store?.close(); instrumentation?.close(); }, () => server.close());
  }
  closes.push(() => client.close().catch(() => undefined));
  return { client, revoke: () => tokens.revoke(`group:${G}`) };
}

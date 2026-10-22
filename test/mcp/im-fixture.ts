/** 真实 im stdio 子进程 + 线程令牌 loopback：网关按调用元数据给出本次调用的绑定（模拟会话当前回合）。 */
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CALL_META_HEADER, ThreadTokens, startMediaRecallServer, type CallBinding, type CallMeta, type ThreadGateway } from "../../src/context/media-recall-server.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

export async function imRig(threadKey: string, gateway: Omit<ThreadGateway, "resolve"> & { resolve(meta: CallMeta): CallBinding | Promise<CallBinding> }) {
  const tokens = new ThreadTokens({ recall: async () => ({ text: "", images: [] }) }, { ...gateway, resolve: async (_key, meta) => gateway.resolve(meta) });
  const server = await startMediaRecallServer(tokens, 0); cleanup.push(() => server.close());
  const token = tokens.issue(threadKey);
  const client = new Client({ name: "im-test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("../../dist/mcp/im.js", import.meta.url))],
    env: { ...process.env, IM_TOKEN: token, MEDIA_RECALL_PORT: String(server.port) } as Record<string, string>, stderr: "pipe" }));
  cleanup.push(() => client.close());
  let n = 0;
  /** MCP 调用：codex 随每次 tools/call 提供 _meta.callId（缺省自动编号） */
  const tool = (name: string, args: Record<string, unknown> = {}, callId = `exec-${++n}`) =>
    client.callTool({ name, arguments: args, _meta: { callId, "x-codex-turn-metadata": { thread_id: "thr-1" } } });
  const post = (route: string, args: unknown, meta: CallMeta = { callId: `exec-http-${++n}` }, auth = token) => fetch(`http://127.0.0.1:${server.port}/${route}`, {
    method: "POST", headers: { Authorization: "Bearer " + auth, [CALL_META_HEADER]: JSON.stringify(meta) }, body: JSON.stringify(args),
  });
  return { tokens, server, token, client, tool, post };
}

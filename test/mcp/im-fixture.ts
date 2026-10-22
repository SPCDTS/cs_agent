/**
 * im MCP + 线程令牌 loopback：网关按调用元数据给出本次调用的绑定（模拟会话当前回合）。
 * 缺省在进程内按 src/mcp/im.ts 的接线创建服务（经真实 loopback HTTP 调主进程）；stdio=true 时启动构建后的
 * dist/mcp/im.js 子进程（只在集成项目里用，见 vitest.config.ts）。
 */
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createImServer, imViaLoopback, sendViaLoopback } from "../../src/mcp/im-server.js";
import path from "node:path";
import { sendFixture } from "../agent/send-fixture.js";
import { CALL_META_HEADER, ThreadTokens, startMediaRecallServer, type CallBinding, type CallMeta, type ThreadGateway } from "../../src/context/media-recall-server.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

export async function imRig(threadKey: string, gateway: Omit<ThreadGateway, "resolve"> & { resolve(meta: CallMeta): CallBinding | Promise<CallBinding> },
  { stdio = false }: { stdio?: boolean } = {}) {
  const tokens = new ThreadTokens({ recall: async () => ({ text: "", images: [] }) }, { ...gateway, resolve: async (_key, meta) => gateway.resolve(meta) });
  const server = await startMediaRecallServer(tokens, 0); cleanup.push(() => server.close());
  const token = tokens.issue(threadKey);
  const client = new Client({ name: "im-test", version: "1" });
  if (stdio) {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL("../../dist/mcp/im.js", import.meta.url))],
      env: { ...process.env, IM_TOKEN: token, MEDIA_RECALL_PORT: String(server.port) } as Record<string, string>, stderr: "pipe" }));
  } else {
    // 与 src/mcp/im.ts 的 main() 相同的接线
    const port = server.port;
    const im = createImServer({
      send: (args, meta) => sendViaLoopback(args, meta, token, port),
      auth: (name, args, meta) => imViaLoopback(name, args, meta, token, port),
      skillPublish: (args, meta) => imViaLoopback("skill_publish", args, meta, token, port),
      schedule: async (name, args, meta) => {
        const result = await imViaLoopback(name, args, meta, token, port);
        if (typeof result !== "string") throw new Error("定时工具返回格式错误");
        return result;
      },
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await im.connect(serverSide);
    await client.connect(clientSide);
    cleanup.push(() => im.close());
  }
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

/** im 发送装置：SendService（假 OneBot）+ imRig；current.binding 即网关给出的本次调用绑定，调用键为 MCP 的 _meta.callId。 */
export async function imSendRig({ stdio = false }: { stdio?: boolean } = {}) {
  const f = sendFixture();
  const current: { binding: CallBinding } = { binding: { ...f.binding, turnId: "t1", session: "thr-1",
    imageDir: path.join(f.dir, "images", "group_7") } };
  const rig = await imRig(f.threadKey, {
    resolve: () => current.binding,
    send: (b, callKey, args, signal) => f.service.send(b, args, callKey, signal),
  }, { stdio });
  return { ...f, ...rig, current };
}

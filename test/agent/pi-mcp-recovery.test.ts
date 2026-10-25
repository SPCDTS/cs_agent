import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

const fixture = fileURLToPath(new URL("./fixtures/pi-mcp-recovery.mjs", import.meta.url));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const messageSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("ready") }), z.object({ phase: z.literal("committed") }),
  z.object({ phase: z.literal("error"), message: z.string() }),
  z.object({ phase: z.literal("recovered"), pending: z.number(), terminals: z.array(z.string()),
    results: z.array(z.object({ isError: z.boolean(), codes: z.array(z.string()), text: z.string() })) }),
]);
type ChildMessage = z.infer<typeof messageSchema>;

/** 父进程持有远端计数，强杀 Pi 子进程不会丢失这份证据。 */
async function serverFixture(hang: boolean) {
  let calls = 0, requests = 0;
  const server = createServer(async (request, response) => {
    request.on("error", () => {}); response.on("error", () => {});
    requests++;
    if (request.method === "GET") { response.writeHead(405).end(); return; }
    if (request.method === "DELETE") { response.writeHead(202).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const message = JSONRPCMessageSchema.parse(input);
    if (!("method" in message) || !("id" in message)) { response.writeHead(202).end(); return; }
    let result: unknown;
    if (message.method === "initialize") {
      result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "recovery-fixture", version: "1" } };
    } else if (message.method === "tools/list") {
      result = { tools: [{ name: "increment", inputSchema: { type: "object", additionalProperties: false } }] };
    } else if (message.method === "tools/call") {
      calls++;
      if (hang) return;
      result = { content: [{ type: "text", text: "committed-success" }] };
    } else { response.writeHead(202).end(); return; }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_address");
  return { url: `http://127.0.0.1:${address.port}/mcp`, get calls() { return calls; }, get requests() { return requests; } };
}

function worker(mode: "hang" | "committed" | "recover", directory: string, url: string) {
  const child = fork(fixture, [mode, directory, url], { execArgv: [], windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const messages: ChildMessage[] = [];
  let output = "", exited = false;
  const capture = (data: Buffer) => { output = (output + data.toString("utf8")).slice(-16_384); };
  child.stdout?.on("data", capture); child.stderr?.on("data", capture);
  child.on("message", value => {
    const parsed = messageSchema.safeParse(value);
    if (parsed.success) messages.push(parsed.data);
    else output += "\ninvalid_fixture_message";
  });
  const exit = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => { exited = true; resolve(); });
  });
  const kill = async () => { if (!exited) child.kill("SIGKILL"); await exit; };
  cleanup.push(kill);
  return {
    messages, exit, kill,
    async wait(phase: ChildMessage["phase"]) {
      await expect.poll(() => {
        const error = messages.find(message => message.phase === "error");
        if (error) throw new Error(error.message);
        if (exited && !messages.some(message => message.phase === phase)) throw new Error(`fixture exited: ${output}`);
        return messages.some(message => message.phase === phase);
      }, { timeout: 10_000, interval: 20 }).toBe(true);
    },
  };
}

describe("Pi MCP 真进程强杀恢复", () => {
  it.each([true, false])("远端挂起=%s：同 SQLite 恢复不重发 tools/call", async hang => {
    const server = await serverFixture(hang);
    const directory = await mkdtemp(path.join(tmpdir(), "pi-mcp-recovery-"));
    cleanup.push(async () => {
      if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith("pi-mcp-recovery-")) throw new Error("fixture_cleanup_path");
      await rm(directory, { recursive: true, force: true });
    });
    const first = worker(hang ? "hang" : "committed", directory, server.url);
    await first.wait("ready");
    await expect.poll(() => server.calls, { timeout: 10_000 }).toBe(1);
    if (!hang) await first.wait("committed");
    await first.kill();
    const beforeRecovery = server.requests;
    const recovered = worker("recover", directory, server.url);
    await recovered.wait("recovered");
    await recovered.exit;
    const result = recovered.messages.find(message => message.phase === "recovered");
    if (!result || result.phase !== "recovered") throw new Error("fixture_result_missing");
    expect(result.pending).toBe(0);
    expect(result.results).toHaveLength(1);
    if (hang) {
      expect(result.results[0]).toMatchObject({ isError: true, codes: ["interrupted"] });
      expect(result.terminals).toEqual(["interrupted"]);
    } else {
      expect(result.results[0]).toMatchObject({ isError: false, codes: [], text: "committed-success" });
      expect(result.terminals).toEqual([]);
    }
    expect(server.calls).toBe(1);
    expect(server.requests).toBe(beforeRecovery);
  });
});

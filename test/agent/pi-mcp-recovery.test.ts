import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { httpFixture } from "./fixtures/pi-mcp-http.js";

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
    // 远端计数在父进程的 HTTP 桩里，强杀 Pi 子进程不会丢失这份证据。
    const server = await httpFixture(hang ? "hang" : "json");
    cleanup.push(server.close);
    const directory = await mkdtemp(path.join(tmpdir(), "pi-mcp-recovery-"));
    cleanup.push(async () => {
      if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith("pi-mcp-recovery-")) throw new Error("fixture_cleanup_path");
      await rm(directory, { recursive: true, force: true });
    });
    const first = worker(hang ? "hang" : "committed", directory, server.config.transport.url);
    await first.wait("ready");
    await expect.poll(() => server.calls, { timeout: 10_000 }).toBe(1);
    if (!hang) await first.wait("committed");
    await first.kill();
    const recovered = worker("recover", directory, server.config.transport.url);
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
      // 桩故意返回不符输出 schema 的结构化结果；恢复复用这条已提交的拒绝结果。
      expect(result.results[0]).toMatchObject({ isError: true, codes: ["result_rejected"] });
      expect(result.terminals).toEqual([]);
    }
    expect(server.calls).toBe(1);
    expect(server.messages.filter(message => "method" in message && message.method === "tools/call")).toHaveLength(1);
    // 再次重启：快照里仍有这条恢复结果，但终态已由产生它的进程报告过。
    const restarted = worker("recover", directory, server.config.transport.url);
    await restarted.wait("recovered");
    await restarted.exit;
    expect(restarted.messages.find(message => message.phase === "recovered")).toMatchObject({
      results: result.results, terminals: [] });
    expect(server.calls).toBe(1);
  });
});

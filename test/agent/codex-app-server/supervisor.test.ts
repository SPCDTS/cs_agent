import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcClosedError, RpcConnection, RpcTimeoutError } from "../../../src/agent/codex/app-server/rpc.js";
import { AppServerSupervisor } from "../../../src/agent/codex/app-server/supervisor.js";
import { logBuffer, setLogLevel } from "../../../src/shared/log.js";
import { defaultHandlers, fakeSpawn, flush, type Message } from "./fake-app-server.js";

const supervisors: AppServerSupervisor[] = [];
function supervise(rig = fakeSpawn(), extra: Partial<ConstructorParameters<typeof AppServerSupervisor>[0]> = {}) {
  const killTree = vi.fn();
  const sup = new AppServerSupervisor({
    command: ["codex", "--flag"], args: ["-c", "features.multi_agent=true"], cwd: "/ws",
    env: { CODEX_HOME: "/codex-home", PATH: "/bin" }, spawn: rig.spawn, killTree, ...extra,
  });
  supervisors.push(sup);
  return { sup, rig, killTree };
}
afterEach(async () => {
  for (const sup of supervisors.splice(0)) await sup.stop(0);
  vi.useRealTimers();
  setLogLevel("info");
});

describe("app-server 监管器", () => {
  it("启动握手：参数、环境、initialize 后发 initialized", async () => {
    const { sup, rig } = supervise(undefined, { capabilities: { experimentalApi: true } });
    const ready = vi.fn();
    sup.on("ready", ready);
    sup.start();
    await sup.ready();
    expect(rig.calls).toEqual([{ bin: "codex", args: ["--flag", "app-server", "-c", "features.multi_agent=true"], cwd: "/ws",
      env: { CODEX_HOME: "/codex-home", PATH: "/bin" } }]);
    await flush();
    expect(rig.last.received).toEqual([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "cs_agent", version: "0.1.0" }, capabilities: { experimentalApi: true } } },
      { jsonrpc: "2.0", method: "initialized" },
    ]);
    expect(ready).toHaveBeenCalledWith(1);
    expect(sup.state).toBe("ready");
  });

  it("进程崩溃：拒绝未完成请求，按 1s→2s 退避重启并发出 restarted；稳定运行后退避归零", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { sup, rig, killTree } = supervise(fakeSpawn(() => defaultHandlers({ "slow/op": () => undefined })), { stableMs: 30_000 });
    const events: string[] = [];
    sup.on("down", e => events.push(`down:${e.generation}:${e.wasReady}`));
    sup.on("restarted", g => events.push(`restarted:${g}`));
    sup.start();
    await sup.ready();
    const pending = sup.request("slow/op", {});
    await flush();
    rig.last.exit(137);
    await expect(pending).rejects.toBeInstanceOf(RpcClosedError);
    expect(killTree).toHaveBeenCalledWith(1000);
    expect(sup.state).toBe("backoff");
    await vi.advanceTimersByTimeAsync(999);
    expect(rig.children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(rig.children).toHaveLength(2);
    await sup.ready();
    // 第二代很快又崩：退避翻倍到 2s。
    rig.last.exit(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(rig.children).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    await sup.ready();
    expect(sup.generation).toBe(3);
    // 稳定运行超过 stableMs 后再崩：退避回到 1s。
    await vi.advanceTimersByTimeAsync(30_000);
    rig.last.exit(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    await sup.ready();
    expect(events).toEqual(["down:1:true", "restarted:2", "down:2:true", "restarted:3", "down:3:true", "restarted:4"]);
  });

  it("退避上限 60s；握手失败也算掉线", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const rig = fakeSpawn(() => defaultHandlers({ initialize: () => ({ error: { code: -32000, message: "boom" } }) }));
    const { sup } = supervise(rig);
    sup.start();
    await flush();
    let launched = 1;
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(rig.children).toHaveLength(launched);
      await vi.advanceTimersByTimeAsync(1);
      await flush();
      expect(rig.children).toHaveLength(++launched);
    }
    expect(sup.state).toBe("backoff");
  });

  it("spawn 抛错进入退避；stop 后不再重启并结束进程", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let fail = true;
    const rig = fakeSpawn();
    const { sup, killTree } = supervise({ ...rig, spawn: (bin, args, opts) => { if (fail) throw new Error("ENOENT"); return rig.spawn(bin, args, opts); } });
    sup.start();
    expect(sup.state).toBe("backoff");
    fail = false;
    await vi.advanceTimersByTimeAsync(1_000);
    await sup.ready();
    const child = rig.last;
    await sup.stop(0);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(killTree).toHaveBeenCalledWith(child.pid);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(rig.children).toHaveLength(1);
    await expect(sup.ready()).rejects.toThrow("已停止");
  });
});

describe("JSON-RPC 连接", () => {
  function conn(opts: ConstructorParameters<typeof RpcConnection>[2] = {}) {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const sent: Message[] = [];
    stdin.on("data", chunk => { for (const l of String(chunk).split("\n").filter(Boolean)) sent.push(JSON.parse(l)); });
    const c = new RpcConnection(stdin, stdout, opts);
    return { c, stdout, sent };
  }

  it("跨 chunk 拼行、跳过损坏行，按 id 配对响应并分发通知", async () => {
    const { c, stdout, sent } = conn();
    const notes: string[] = [];
    c.on("notification", m => notes.push(m));
    const p = c.request("thread/start", { cwd: "/x" });
    await flush();
    expect(sent[0]).toMatchObject({ jsonrpc: "2.0", id: 1, method: "thread/start" });
    stdout.write("{not json\n");
    const line = JSON.stringify({ jsonrpc: "2.0", method: "turn/started", params: {} }) + "\n" + JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: 1 } }) + "\n";
    stdout.write(line.slice(0, 17)); stdout.write(line.slice(17));
    await expect(p).resolves.toEqual({ ok: 1 });
    expect(notes).toEqual(["turn/started"]);
  });

  it("请求超时；迟到响应被忽略；signal 取消", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { c, stdout } = conn({ defaultTimeoutMs: 50 });
    const p = c.request("slow");
    const failure = expect(p).rejects.toBeInstanceOf(RpcTimeoutError);
    await vi.advanceTimersByTimeAsync(50);
    await failure;
    stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) + "\n");
    await flush();
    const ac = new AbortController();
    const q = c.request("other", undefined, { signal: ac.signal, timeoutMs: 0 });
    ac.abort(new Error("取消了"));
    await expect(q).rejects.toThrow("取消了");
  });

  it("服务端请求总会得到答复：缺省拒绝审批、未知方法 -32601，策略可注入", async () => {
    const { stdout, sent } = conn();
    const ask = (id: string, method: string) => stdout.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: { command: "rm -rf /" } }) + "\n");
    ask("a", "item/commandExecution/requestApproval");
    ask("b", "item/fileChange/requestApproval");
    ask("c", "execCommandApproval");
    ask("d", "mcpServer/elicitation/request");
    ask("e", "item/tool/requestUserInput");
    await flush();
    expect(sent).toEqual([
      { jsonrpc: "2.0", id: "a", result: { decision: "decline" } },
      { jsonrpc: "2.0", id: "b", result: { decision: "decline" } },
      { jsonrpc: "2.0", id: "c", result: { decision: "denied" } },
      { jsonrpc: "2.0", id: "d", result: { action: "decline" } },
      { jsonrpc: "2.0", id: "e", error: { code: -32601, message: "Method not supported by cs_agent client" } },
    ]);
    const custom = conn({ onServerRequest: async method => method === "x" ? { result: { decision: "accept" } } : Promise.reject(new Error("bad")) });
    custom.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x" }) + "\n" + JSON.stringify({ jsonrpc: "2.0", id: 2, method: "y" }) + "\n");
    await flush();
    expect(custom.sent).toEqual([
      { jsonrpc: "2.0", id: 1, result: { decision: "accept" } },
      { jsonrpc: "2.0", id: 2, error: { code: -32603, message: "cs_agent client failed to handle request" } },
    ]);
  });

  it("日志只含方法名与 id，不含消息正文", async () => {
    setLogLevel("debug");
    const before = logBuffer.recent().length;
    const { c, stdout } = conn({ defaultTimeoutMs: 20 });
    const secret = "SECRET-用户内容-sk-123";
    const p = c.request("turn/start", { input: [{ type: "text", text: secret }] });
    stdout.write(`{"broken": "${secret}"\n`);
    stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: `no active turn ${secret}`, data: secret } }) + "\n");
    await expect(p).rejects.toThrow("JSON-RPC -32600");
    await expect(p).rejects.not.toThrow(secret);
    stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "item/commandExecution/requestApproval", params: { command: secret } }) + "\n");
    await expect(c.request("slow", { secret })).rejects.toBeInstanceOf(RpcTimeoutError);
    const lines = logBuffer.recent().slice(before);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(lines)).not.toContain(secret);
  });
});

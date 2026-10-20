import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compactAppServer, type CompactChild } from "../../src/agent/codex/app-server-compact.js";

type Message = { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
class FakeChild extends EventEmitter implements CompactChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly messages: Message[] = [];
  readonly kill = vi.fn(() => true);
  readonly unref = vi.fn();
  readonly pid = 123;
  readonly stdin = new Writable({ write: (data, _encoding, done) => {
    const message = JSON.parse(String(data)) as Message;
    this.messages.push(message);
    queueMicrotask(() => this.handle(message));
    done();
  } });
  constructor(readonly handle: (message: Message) => void) { super(); }
  emitMessage(message: Message) { this.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); }
}
const threadId = "thread-test";
function rig(onCompact: (child: FakeChild, message: Message) => void = () => undefined) {
  const child = new FakeChild(message => {
    if (message.method === "initialize" || message.method === "thread/resume") child.emitMessage({ id: message.id, result: {} });
    if (message.method === "thread/compact/start") onCompact(child, message);
  });
  return child;
}
const item = (id = threadId): Message => ({
  method: "item/completed", params: { threadId: id, turnId: "turn-1", item: { id: "compact-1", type: "contextCompaction" } },
});
afterEach(() => vi.useRealTimers());

describe("app-server 压缩协议", () => {
  it("按顺序握手、恢复和压缩，处理分片行并清理子进程", async () => {
    const child = rig((c, message) => {
      c.emitMessage({ id: message.id, result: {} });
      const line = JSON.stringify(item()) + "\n";
      c.stdout.write(line.slice(0, 20)); c.stdout.write(line.slice(20));
    });
    const killTree = vi.fn();
    await compactAppServer(threadId, { start: () => child, killTree });
    expect(child.messages).toEqual([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "cs_agent_compact", version: "0.1.0" } } },
      { jsonrpc: "2.0", method: "initialized" },
      { jsonrpc: "2.0", id: 2, method: "thread/resume", params: { threadId } },
      { jsonrpc: "2.0", id: 3, method: "thread/compact/start", params: { threadId } },
    ]);
    expect(killTree).toHaveBeenCalledWith(123);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed).toBe(true);
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it.each(["item/completed", "turn/completed", "thread/compacted"])("接受 %s 完成通知早于 start 响应", async method => {
    const child = rig((c, message) => {
      c.emitMessage({ method: "turn/started", params: { threadId, turn: { id: "turn-1", status: "inProgress" } } });
      c.emitMessage({ method, params: { ...item().params, turn: { id: "turn-1", status: "completed", error: null } } });
      c.emitMessage({ id: message.id, result: {} });
    });
    await expect(compactAppServer(threadId, { start: () => child })).resolves.toBeUndefined();
  });

  it("忽略其他线程、旧回合与普通 item；未完成则超时并 kill", async () => {
    vi.useFakeTimers();
    const child = rig((c, message) => {
      c.emitMessage({ id: message.id, result: {} });
      c.emitMessage(item("other-thread"));
      c.emitMessage({ method: "turn/started", params: { threadId, turn: { id: "new-turn" } } });
      c.emitMessage(item());
      c.emitMessage({ method: "item/completed", params: { threadId, turnId: "new-turn", item: { type: "agentMessage" } } });
    });
    const pending = compactAppServer(threadId, { start: () => child, timeoutMs: 50 });
    const failure = expect(pending).rejects.toThrow("压缩超时");
    await vi.advanceTimersByTimeAsync(50);
    await failure;
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("initialize 不响应也受同一个 5 分钟硬超时约束", async () => {
    vi.useFakeTimers();
    const child = new FakeChild(() => undefined);
    const failure = expect(compactAppServer(threadId, { start: () => child })).rejects.toThrow("压缩超时");
    await vi.advanceTimersByTimeAsync(300_000);
    await failure;
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("不把 resume 中的旧完成通知当成本次压缩", async () => {
    vi.useFakeTimers();
    const child = new FakeChild(message => {
      if (message.method === "thread/resume") child.emitMessage(item());
      if (message.id !== undefined) child.emitMessage({ id: message.id, result: {} });
    });
    const failure = expect(compactAppServer(threadId, { start: () => child, timeoutMs: 50 })).rejects.toThrow("压缩超时");
    await vi.advanceTimersByTimeAsync(50); await failure;
  });

  it("不支持的服务端请求返回同 ID 的 -32601 错误", async () => {
    const child = rig((c, message) => {
      c.emitMessage({ method: "item/commandExecution/requestApproval", id: 3, params: { threadId } });
      c.emitMessage({ id: message.id, result: {} });
      c.emitMessage(item());
    });
    await compactAppServer(threadId, { start: () => child });
    expect(child.messages).toContainEqual({ jsonrpc: "2.0", id: 3,
      error: { code: -32601, message: "Method not supported by compaction client" } });
  });

  it.each(["initialize", "thread/resume", "thread/compact/start"])("%s RPC 错误不会泄露正文，且 kill", async method => {
    const child = new FakeChild(message => {
      if (!message.id) return;
      child.emitMessage(message.method === method
        ? { id: message.id, error: { code: -32603, message: "secret-image-and-content" } }
        : { id: message.id, result: {} });
    });
    const failure = await compactAppServer(threadId, { start: () => child }).catch(error => error as Error);
    if (!(failure instanceof Error)) throw new Error("预期 RPC 失败");
    expect(failure.message).toContain(method);
    expect(failure.message).toContain("-32603");
    expect(failure.message).not.toContain("secret");
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it.each(["failed", "interrupted"])("turn/completed 的 %s 状态为失败", async status => {
    const child = rig((c, message) => {
      c.emitMessage({ id: message.id, result: {} });
      c.emitMessage({ method: "turn/completed", params: { threadId, turn: { id: "turn-1", status } } });
    });
    await expect(compactAppServer(threadId, { start: () => child })).rejects.toThrow("失败或被中断");
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("服务端 error 通知区分可重试与终止错误", async () => {
    const child = rig((c, message) => {
      c.emitMessage({ id: message.id, result: {} });
      c.emitMessage({ method: "error", params: { threadId, willRetry: true } });
      c.emitMessage({ method: "error", params: { threadId, willRetry: false, error: { message: "secret" } } });
    });
    await expect(compactAppServer(threadId, { start: () => child })).rejects.toThrow("服务端 error 通知");
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it.each(["invalid-json", "exit", "spawn-error", "pipe-error"])("%s 清理进程并拒绝", async kind => {
    const child = new FakeChild(() => {
      if (kind === "invalid-json") child.stdout.write("not-json\n");
      if (kind === "exit") child.emit("close", 1);
      if (kind === "spawn-error") child.emit("error", new Error("secret"));
      if (kind === "pipe-error") child.stdin.emit("error", new Error("secret"));
    });
    await expect(compactAppServer(threadId, { start: () => child })).rejects.toThrow("codex app-server");
    expect(child.kill).toHaveBeenCalledOnce();
  });
});

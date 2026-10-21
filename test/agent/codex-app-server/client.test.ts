import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient, ThreadNotLoadedError, type ClientEvents } from "../../../src/agent/codex/app-server/client.js";
import { AppServerSupervisor } from "../../../src/agent/codex/app-server/supervisor.js";
import { logBuffer, setLogLevel } from "../../../src/shared/log.js";
import { defaultHandlers, fakeSpawn, flush, type FakeAppServer, type Handler } from "./fake-app-server.js";

const supervisors: AppServerSupervisor[] = [];
afterEach(async () => {
  for (const sup of supervisors.splice(0)) await sup.stop(0);
  vi.useRealTimers();
  setLogLevel("info");
});

async function rig(extra: Record<string, Handler> = {}) {
  const spawn = fakeSpawn(() => defaultHandlers(extra));
  const sup = new AppServerSupervisor({ command: ["codex"], cwd: "/ws", env: {}, spawn: spawn.spawn, killTree: () => undefined });
  supervisors.push(sup);
  const client = new CodexAppServerClient(sup);
  const events: Array<[keyof ClientEvents, unknown]> = [];
  for (const name of ["turnStarted", "turnCompleted", "turnLost", "turnError", "item", "subAgent", "childActivity", "restarted"] as const) {
    client.on(name, (event: unknown) => events.push([name, event]));
  }
  sup.start();
  await sup.ready();
  return { sup, spawn, client, events, server: () => spawn.last };
}
const names = (events: Array<[string, unknown]>) => events.map(([name]) => name);
const turnStarted = (s: FakeAppServer, threadId: string, id: string) => s.notify("turn/started", { threadId, turn: { id, status: "inProgress", items: [] } });
const turnCompleted = (s: FakeAppServer, threadId: string, id: string, status = "completed", error: unknown = null) =>
  s.notify("turn/completed", { threadId, turn: { id, status, error, items: [] } });

describe("app-server 客户端", () => {
  it("startThread / resumeThread：默认 never + workspace-write，配置覆盖与基础指令文件进 config", async () => {
    const { client, server } = await rig();
    const id = await client.startThread({
      cwd: "/ws/t", model: "gpt-x", modelInstructionsFile: "/codex/base.md",
      config: { "mcp_servers.im.env.IM_TOKEN": "tok-a" },
    });
    expect(id).toBe("thr-1");
    expect(server().requests("thread/start")[0]!.params).toEqual({
      approvalPolicy: "never", sandbox: "workspace-write", cwd: "/ws/t", model: "gpt-x",
      config: { "mcp_servers.im.env.IM_TOKEN": "tok-a", model_instructions_file: "/codex/base.md" },
    });
    await expect(client.resumeThread("thr-old", { config: { "mcp_servers.im.env.IM_TOKEN": "tok-b" } })).resolves.toBe("thr-old");
    expect(server().requests("thread/resume")[0]!.params).toEqual({
      threadId: "thr-old", approvalPolicy: "never", sandbox: "workspace-write", config: { "mcp_servers.im.env.IM_TOKEN": "tok-b" },
    });
    expect(client.thread("thr-old")).toMatchObject({ loaded: true });
    expect(client.thread("thr-old")!.activeTurnId).toBeUndefined();
    await expect(client.startTurn("never-loaded", [{ type: "text", text: "hi" }])).rejects.toBeInstanceOf(ThreadNotLoadedError);
  });

  it("startTurn：turn/started 早于响应也判定为 client；item 与 completed 事件；回合结束后空闲", async () => {
    const { client, events, server } = await rig({
      "turn/start": (m, s) => {
        turnStarted(s, m.params!.threadId as string, "turn-A");
        s.notify("item/started", { threadId: m.params!.threadId, turnId: "turn-A", item: { id: "u1", type: "userMessage", content: [] } });
        return { result: { turn: { id: "turn-A", status: "inProgress", items: [] } } };
      },
    });
    const thread = await client.startThread();
    const turnId = await client.startTurn(thread, [{ type: "text", text: "你好" }, { type: "localImage", path: "/in/a.png" }], { effort: "high", model: "gpt-y" });
    expect(turnId).toBe("turn-A");
    expect(server().requests("turn/start")[0]!.params).toEqual({
      threadId: thread, effort: "high", model: "gpt-y",
      input: [{ type: "text", text: "你好", text_elements: [] }, { type: "localImage", path: "/in/a.png" }],
    });
    expect(client.thread(thread)!.activeTurnId).toBe("turn-A");
    server().notify("item/completed", { threadId: thread, turnId: "turn-A", item: { id: "call-1", type: "mcpToolCall", server: "im", tool: "send_message" } });
    turnCompleted(server(), thread, "turn-A");
    await flush();
    expect(events).toEqual([
      ["item", { threadId: thread, turnId: "turn-A", phase: "started", item: { id: "u1", type: "userMessage", content: [] } }],
      ["turnStarted", { threadId: thread, turnId: "turn-A", initiatedBy: "client" }],
      ["item", { threadId: thread, turnId: "turn-A", phase: "completed", item: { id: "call-1", type: "mcpToolCall", server: "im", tool: "send_message" } }],
      ["turnCompleted", { threadId: thread, turnId: "turn-A", status: "completed" }],
    ]);
    expect(client.thread(thread)!.activeTurnId).toBeUndefined();
  });

  it("响应先到、turn/started 后到也判定为 client；失败回合带 error", async () => {
    const { client, events, server } = await rig();
    const thread = await client.startThread();
    const turnId = await client.startTurn(thread, [{ type: "text", text: "x" }]);
    turnStarted(server(), thread, turnId);
    server().notify("error", { threadId: thread, turnId, willRetry: false, error: { message: "upstream 500", codexErrorInfo: "internalServerError" } });
    turnCompleted(server(), thread, turnId, "failed", { message: "upstream 500" });
    await flush();
    expect(events).toEqual([
      ["turnStarted", { threadId: thread, turnId, initiatedBy: "client" }],
      ["turnError", { threadId: thread, turnId, willRetry: false, error: { message: "upstream 500", codexErrorInfo: "internalServerError" } }],
      ["turnCompleted", { threadId: thread, turnId, status: "failed", error: { message: "upstream 500" } }],
    ]);
  });

  it("steer：成功返回 ok；过期/无活动回合映射为 no_active_turn；review/compact 回合为 not_steerable", async () => {
    let reply: { result?: unknown; error?: { code: number; message: string; data?: unknown } } = { result: { turnId: "turn-1" } };
    const { client, server } = await rig({ "turn/steer": () => reply });
    const thread = await client.startThread();
    const input = [{ type: "text" as const, text: "补充" }];
    await expect(client.steer(thread, "turn-1", input)).resolves.toBe("ok");
    expect(server().requests("turn/steer")[0]!.params).toEqual({ threadId: thread, expectedTurnId: "turn-1", input: [{ type: "text", text: "补充", text_elements: [] }] });
    reply = { error: { code: -32600, message: "no active turn to steer" } };
    await expect(client.steer(thread, "turn-1", input)).resolves.toBe("no_active_turn");
    reply = { error: { code: -32600, message: "expected active turn id `turn-1` but found `turn-2`" } };
    await expect(client.steer(thread, "turn-1", input)).resolves.toBe("no_active_turn");
    reply = { error: { code: -32600, message: "cannot steer a review turn" } };
    await expect(client.steer(thread, "turn-1", input)).resolves.toBe("not_steerable");
    reply = { error: { code: -32600, message: "x", data: { codexErrorInfo: { activeTurnNotSteerable: { turnKind: "compact" } } } } };
    await expect(client.steer(thread, "turn-1", input)).resolves.toBe("not_steerable");
    reply = { error: { code: -32603, message: "internal" } };
    await expect(client.steer(thread, "turn-1", input)).rejects.toThrow("JSON-RPC -32603");
    reply = { error: { code: -32600, message: "thread not found: abc" } };
    await expect(client.steer(thread, "turn-1", input)).rejects.toBeInstanceOf(ThreadNotLoadedError);
    expect(client.thread(thread)!.loaded).toBe(false);
  });

  it("子 agent：完成后服务端自行开启的唤醒回合标为 server；子线程事件归到父线程且不改父回合状态", async () => {
    let now = 1_000;
    const { client, events, server, sup } = await rig();
    const local = new CodexAppServerClient(sup, { now: () => now });
    const localEvents: Array<[string, unknown]> = [];
    for (const name of ["turnStarted", "subAgent", "childActivity", "turnCompleted"] as const) local.on(name, (e: unknown) => localEvents.push([name, e]));
    const thread = await local.startThread();
    const turnId = await local.startTurn(thread, [{ type: "text", text: "派个子 agent" }]);
    const s = server();
    turnStarted(s, thread, turnId);
    // 子线程 child-1 由 thread/started 的 parentThreadId 建立映射；孙线程 child-2 由 child-1 的 subAgentActivity 建立。
    s.notify("thread/started", { thread: { id: "child-1", parentThreadId: thread } });
    s.notify("item/completed", { threadId: thread, turnId, item: { id: "sa-1", type: "subAgentActivity", kind: "started", agentThreadId: "child-1", agentPath: "a" } });
    turnCompleted(s, thread, turnId);
    await flush();
    now = 5_000;
    turnStarted(s, "child-1", "child-turn");
    s.notify("item/completed", { threadId: "child-1", turnId: "child-turn", item: { id: "sa-2", type: "subAgentActivity", kind: "started", agentThreadId: "child-2" } });
    s.notify("item/completed", { threadId: "child-2", turnId: "gc", item: { id: "c", type: "agentMessage", text: "x" } });
    s.notify("item/completed", { threadId: "stranger", turnId: "z", item: { id: "c", type: "agentMessage", text: "x" } });
    await flush();
    expect(local.thread(thread)!.activeTurnId).toBeUndefined();
    expect(local.thread(thread)!.lastActivityAt).toBe(5_000);
    expect(local.thread("child-1")).toBeUndefined();
    // 子 agent 完成 → 父线程收到 subAgentActivity completed → 服务端开唤醒回合。
    s.notify("item/started", { threadId: thread, turnId, item: { id: "sa-3", type: "subAgentActivity", kind: "completed", agentThreadId: "child-1" } });
    s.notify("item/completed", { threadId: thread, turnId, item: { id: "sa-3", type: "subAgentActivity", kind: "completed", agentThreadId: "child-1" } });
    turnStarted(s, thread, "wake-1");
    await flush();
    expect(local.thread(thread)!.activeTurnId).toBe("wake-1");
    expect(localEvents).toEqual([
      ["turnStarted", { threadId: thread, turnId, initiatedBy: "client" }],
      ["subAgent", expect.objectContaining({ parentThreadId: thread, kind: "started", agentThreadId: "child-1" })],
      ["turnCompleted", { threadId: thread, turnId, status: "completed" }],
      ["childActivity", { parentThreadId: thread, agentThreadId: "child-1", method: "turn/started" }],
      ["childActivity", { parentThreadId: thread, agentThreadId: "child-1", method: "item/completed" }],
      ["childActivity", { parentThreadId: thread, agentThreadId: "child-2", method: "item/completed" }],
      ["subAgent", expect.objectContaining({ parentThreadId: thread, kind: "completed", agentThreadId: "child-1" })],
      ["turnStarted", { threadId: thread, turnId: "wake-1", initiatedBy: "server" }],
    ]);
    // 另一个客户端实例没有跟踪这些线程，什么都不发。
    expect(events).toEqual([]);
  });

  it("唤醒回合与本端 turn/start 并发：未返回期间暂存，按响应 id 判定", async () => {
    let release!: () => void;
    const { client, events, server } = await rig({
      "turn/start": (m, s) => {
        turnStarted(s, m.params!.threadId as string, "wake-9");
        release = () => s.respond(m.id, { result: { turn: { id: "mine-1" } } });
        return undefined;
      },
    });
    const thread = await client.startThread();
    const pending = client.startTurn(thread, [{ type: "text", text: "x" }]);
    await flush();
    expect(names(events)).toEqual([]);
    release();
    await expect(pending).resolves.toBe("mine-1");
    expect(events).toEqual([["turnStarted", { threadId: thread, turnId: "wake-9", initiatedBy: "server" }]]);
  });

  it("服务端请求在客户端门面下同样被答复", async () => {
    const { server } = await rig();
    const reply = await server().request("item/commandExecution/requestApproval", { threadId: "t", command: "ls" });
    expect(reply).toEqual({ jsonrpc: "2.0", id: "srv-1", result: { decision: "decline" } });
    const unknown = await server().request("item/tool/call", {});
    expect(unknown.error).toEqual({ code: -32601, message: "Method not supported by cs_agent client" });
  });

  it("进程崩溃：进行中回合 turnLost、线程空闲且需 resume；退避重启后 restarted，resume 后可开新回合", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { client, events, server, spawn } = await rig();
    const a = await client.startThread();
    const b = await client.startThread();
    const turnId = await client.startTurn(a, [{ type: "text", text: "长任务" }]);
    turnStarted(server(), a, turnId);
    await flush();
    events.length = 0;
    server().exit(137);
    await flush();
    expect(events).toEqual([["turnLost", { threadId: a, turnId, reason: "进程退出（code 137）" }]]);
    expect(client.thread(a)).toMatchObject({ loaded: false });
    expect(client.thread(a)!.activeTurnId).toBeUndefined();
    expect(client.thread(b)).toMatchObject({ loaded: false });
    await expect(client.startTurn(a, [{ type: "text", text: "x" }])).rejects.toBeInstanceOf(ThreadNotLoadedError);
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(spawn.children).toHaveLength(2);
    expect(events.at(-1)).toEqual(["restarted", 2]);
    await client.resumeThread(a);
    expect(client.thread(a)).toMatchObject({ loaded: true });
    await expect(client.startTurn(a, [{ type: "text", text: "再说一次" }])).resolves.toBe("turn-1");
    await expect(client.startTurn(b, [{ type: "text", text: "x" }])).rejects.toBeInstanceOf(ThreadNotLoadedError);
  });

  it("请求超时：startTurn 抛错且不残留进行中计数", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { client, events, server } = await rig({ "turn/start": () => undefined });
    const thread = await client.startThread();
    const pending = client.startTurn(thread, [{ type: "text", text: "x" }], { timeoutMs: 100 });
    const failure = expect(pending).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(100);
    await failure;
    turnStarted(server(), thread, "late");
    await flush();
    expect(events).toEqual([["turnStarted", { threadId: thread, turnId: "late", initiatedBy: "server" }]]);
  });

  it("日志不含用户输入、配置令牌或服务端正文", async () => {
    setLogLevel("debug");
    const before = logBuffer.recent().length;
    const secret = "SECRET-私聊内容-tok-xyz";
    const { client, server } = await rig({ "turn/steer": () => ({ error: { code: -32600, message: `no active turn to steer ${secret}` } }) });
    const thread = await client.startThread({ config: { "mcp_servers.im.env.IM_TOKEN": secret } });
    const turnId = await client.startTurn(thread, [{ type: "text", text: secret }]);
    await client.steer(thread, turnId, [{ type: "text", text: secret }]);
    server().notify("item/completed", { threadId: thread, turnId, item: { id: "m", type: "agentMessage", text: secret } });
    await server().request("item/commandExecution/requestApproval", { command: secret });
    server().exit(1);
    await flush();
    const lines = logBuffer.recent().slice(before);
    expect(lines.length).toBeGreaterThan(3);
    expect(JSON.stringify(lines)).not.toContain(secret);
  });
});

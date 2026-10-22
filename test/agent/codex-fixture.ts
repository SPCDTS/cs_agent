/**
 * 常驻 codex app-server 的测试装置：CodexRunner 接内存版 app-server（fake-app-server），
 * CodexScript 按 turn/start 脚本化回合（turn/started、条目、turn/completed 由测试或脚本发出）。
 */
import path from "node:path";
import { CodexRunner, type CodexRunnerOptions } from "../../src/agent/codex/runner.js";
import { defaultHandlers, fakeSpawn, flush, type FakeAppServer, type Handler, type Message } from "./codex-app-server/fake-app-server.js";
import { FIXTURES, tmp } from "./helpers.js";

export interface ScriptTurn {
  threadId: string;
  turnId: string;
  /** turn/start 的文本输入 */
  text: string;
  effort?: string;
  model?: string;
  child: FakeAppServer;
}

/** 回合脚本：turn/start 先发出 turn/started 再答复，随后运行 onTurn；auto 时脚本返回后发出 turn/completed。 */
export class CodexScript {
  readonly turns: ScriptTurn[] = [];
  readonly steers: { threadId: string; turnId: string; text: string }[] = [];
  onTurn?: (turn: ScriptTurn, script: CodexScript) => Promise<void> | void;
  auto = true;
  /** turn/steer 的答复；返回 error 模拟 no_active_turn / not_steerable */
  steerReply?: (message: Message) => { result?: unknown; error?: Message["error"] } | undefined;
  private seq = 0;
  private threadSeq = 0;
  readonly done = new Set<string>();

  handlers = (): Record<string, Handler> => defaultHandlers({
    "thread/start": () => ({ result: { thread: { id: `thr-${++this.threadSeq}` } } }),
    "turn/start": (m, child) => {
      const params = m.params as { threadId: string; input: { text?: string }[]; effort?: string; model?: string };
      const turn: ScriptTurn = { threadId: params.threadId, turnId: `turn-${++this.seq}`, text: params.input.map(i => i.text ?? "").join("\n"),
        ...(params.effort ? { effort: params.effort } : {}), ...(params.model ? { model: params.model } : {}), child };
      this.turns.push(turn);
      // turn/started 先于响应写出（真实 app-server 也可能如此），之后的条目与结束事件都排在它后面
      child.notify("turn/started", { threadId: turn.threadId, turn: { id: turn.turnId, status: "inProgress" } });
      setImmediate(() => { void Promise.resolve(this.onTurn?.(turn, this)).then(() => { if (this.auto) this.complete(turn); }); });
      return { result: { turn: { id: turn.turnId, status: "inProgress", items: [] } } };
    },
    "turn/steer": m => {
      const params = m.params as { threadId: string; expectedTurnId: string; input: { text?: string }[] };
      const custom = this.steerReply?.(m);
      if (custom) return custom;
      if (this.done.has(params.expectedTurnId)) return { error: { code: -32600, message: "no active turn to steer" } };
      this.steers.push({ threadId: params.threadId, turnId: params.expectedTurnId, text: params.input.map(i => i.text ?? "").join("\n") });
      return { result: { turnId: params.expectedTurnId } };
    },
    "turn/interrupt": (m, child) => {
      const params = m.params as { threadId: string; turnId: string };
      setImmediate(() => this.complete({ threadId: params.threadId, turnId: params.turnId, child }, "interrupted"));
      return { result: {} };
    },
  });

  /** 发出 turn/completed（同一回合只发一次）。 */
  complete(turn: Pick<ScriptTurn, "threadId" | "turnId" | "child">, status = "completed"): void {
    if (this.done.has(turn.turnId)) return;
    this.done.add(turn.turnId);
    turn.child.notify("turn/completed", { threadId: turn.threadId, turn: { id: turn.turnId, status, items: [] } });
  }

  /** 服务端自己开一轮（子 agent 完成唤醒）。 */
  wake(child: FakeAppServer, threadId: string): ScriptTurn {
    const turn: ScriptTurn = { threadId, turnId: `wake-${++this.seq}`, text: "", child };
    this.turns.push(turn);
    child.notify("turn/started", { threadId, turn: { id: turn.turnId, status: "inProgress" } });
    return turn;
  }

  /** mcpToolCall 条目开始（callId = 条目 id）。 */
  toolCall(turn: Pick<ScriptTurn, "threadId" | "turnId" | "child">, callId: string, tool = "send_message"): void {
    turn.child.notify("item/started", { threadId: turn.threadId, turnId: turn.turnId,
      item: { type: "mcpToolCall", id: callId, server: "im", tool, status: "inProgress", arguments: {} } });
  }
}

/** CodexRunner 接内存版 app-server；command 仍指向 fake-codex.mjs（只用于模型目录查询）。 */
export async function codexRunnerRig(extra: Partial<CodexRunnerOptions> & { handlers?: () => Record<string, Handler>; dir?: string } = {}) {
  const { handlers, dir: given, ...opts } = extra;
  const dir = given ?? tmp("cs-codex-");
  const fake = fakeSpawn(handlers ?? (() => defaultHandlers()));
  const runner = new CodexRunner({
    command: [process.execPath, path.join(FIXTURES, "fake-codex.mjs")],
    codexHome: path.join(dir, "codex"), workspaceDir: path.join(dir, "ws"), threadsFile: path.join(dir, "codex-threads.json"),
    legacySessionFile: path.join(dir, "codex-session.json"), sandbox: "workspace-write",
    spawn: fake.spawn, supervisor: { backoffInitialMs: 5, backoffMaxMs: 20, readyTimeoutMs: 5_000 },
    ...opts,
  });
  await runner.start();
  const requests = (method: string): Message[] => fake.children.flatMap(child => child.requests(method));
  /** 所有 thread/start 与 thread/resume 请求的参数（按发出顺序） */
  const loads = () => fake.children.flatMap(child => child.received.filter(m => m.id !== undefined &&
    (m.method === "thread/start" || m.method === "thread/resume"))).map(m => m.params as { threadId?: string; cwd: string; config: Record<string, unknown>; model?: string; sandbox?: string });
  return { dir, runner, fake, requests, loads, flush, close: () => runner.stop() };
}

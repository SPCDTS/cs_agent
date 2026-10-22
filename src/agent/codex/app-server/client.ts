/**
 * 常驻 app-server 的类型化门面（设计稿 §5.2、§5.4）：线程开启/恢复、开一轮、插话、中止，
 * 以及按线程跟踪空闲/当前回合（含服务端自行开启的唤醒回合）。
 *
 * - 回合状态只由 turn/started、turn/completed 推导；turnStarted 事件标注 initiatedBy：
 *   本客户端 turn/start 得到的回合为 "client"，其余（wake_on_agent_messages 唤醒）为 "server"。
 *   turn/started 可能早于 turn/start 的响应到达：此时有未返回的 turn/start 就先暂存，等响应拿到 turnId 再判定。
 * - 子 agent 线程不是我们的线程键：从 thread/started 的 parentThreadId 与父线程 subAgentActivity 建立映射，
 *   子线程事件只刷新根父线程的活动时间并以 childActivity 上报，绝不改动父线程的回合状态。
 * - 监管器掉线：所有线程置空闲并标记"未加载"，进行中的回合以 turnLost 上报；重启后调用方须先 resumeThread。
 */
import { EventEmitter } from "node:events";
import { RpcError } from "./rpc.js";
import type { AppServerSupervisor, DownEvent, SupervisedRequestOptions } from "./supervisor.js";

/** 用户输入（UserInput 的子集）：文本与本地图片路径。 */
export type UserInput =
  | { type: "text"; text: string }
  | { type: "localImage"; path: string };

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicy = "untrusted" | "on-request" | "never";

export interface ThreadOptions {
  cwd?: string;
  /** 配置覆盖，点号键，例如 { "mcp_servers.im.env.IM_TOKEN": "…" }；app-server 按线程启动 MCP 子进程并使用其 env。 */
  config?: Record<string, unknown>;
  model?: string;
  /** 基础指令文件；写入 config.model_instructions_file。 */
  modelInstructionsFile?: string;
  baseInstructions?: string;
  developerInstructions?: string;
  /** 缺省 "never"。 */
  approvalPolicy?: ApprovalPolicy;
  /** 缺省 "workspace-write"；null 不发送（由 config 里的命名权限 default_permissions 决定，二者互斥）。 */
  sandbox?: SandboxMode | null;
}

export interface TurnOptions {
  effort?: string;
  model?: string;
  /** 客户端给这条用户消息的 id：出现在该回合 userMessage 条目的 clientId 上（开轮结果不确定时据此认领回合）。 */
  clientUserMessageId?: string;
}

export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** 插话结果：ok；no_active_turn（没有进行中的回合或 expectedTurnId 已过期，调用方改用 startTurn）；
 *  not_steerable（当前回合是 review/compact 等不可插话的回合，调用方排队等它结束）。 */
export type SteerResult = "ok" | "no_active_turn" | "not_steerable";

export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

export interface TurnStartedEvent { threadId: string; turnId: string; initiatedBy: "client" | "server" }
export interface TurnCompletedEvent { threadId: string; turnId: string; status: TurnStatus; error?: TurnError }
export interface TurnLostEvent { threadId: string; turnId: string; reason: string }
export interface TurnErrorEvent { threadId: string; turnId?: string; willRetry: boolean; error?: TurnError }
export interface ItemEvent { threadId: string; turnId?: string; phase: "started" | "completed"; item: ThreadItem }
export interface SubAgentEvent { parentThreadId: string; kind: string; agentThreadId: string; item: ThreadItem }
/** 子 agent 线程的事件；turnId：turn/started、turn/completed 的回合 id（中止子 agent 用）。 */
export interface ChildActivityEvent { parentThreadId: string; agentThreadId: string; method: string; turnId?: string }

/** 服务端 TurnError：message 可能包含提供方返回的文本，只交给调用方判定，不写日志。 */
export interface TurnError { message: string; codexErrorInfo?: unknown; additionalDetails?: string | null }
/** ThreadItem 原样透传（type 区分 userMessage / agentMessage / mcpToolCall / subAgentActivity …，含 id）。 */
export type ThreadItem = { type: string; id?: string } & Record<string, unknown>;

export interface ClientEvents {
  turnStarted: [TurnStartedEvent];
  turnCompleted: [TurnCompletedEvent];
  /** 进程掉线导致进行中的回合丢失（§5.4）。 */
  turnLost: [TurnLostEvent];
  /** error 通知；willRetry=false 表示该回合将失败。 */
  turnError: [TurnErrorEvent];
  item: [ItemEvent];
  subAgent: [SubAgentEvent];
  childActivity: [ChildActivityEvent];
  /** 进程重启就绪：所有线程都需要 resumeThread。 */
  restarted: [generation: number];
}

export interface ThreadSnapshot {
  threadId: string;
  /** 线程已在当前进程代中 start/resume，可直接开回合。 */
  loaded: boolean;
  activeTurnId?: string;
  /** 本线程或其子 agent 最近一次事件的时间（ms），供停滞看门狗使用。 */
  lastActivityAt: number;
}

/** 线程未在当前 app-server 进程中加载（从未 start/resume，或进程重启过）；先 resumeThread。 */
export class ThreadNotLoadedError extends Error {
  constructor(readonly threadId: string) {
    super("codex 线程未加载，需先 thread/resume");
    this.name = "ThreadNotLoadedError";
  }
}

interface DeferredTurn { started: TurnStartedEvent; completed?: TurnCompletedEvent }

interface ThreadState {
  threadId: string;
  loadedGeneration?: number;
  activeTurnId?: string;
  lastActivityAt: number;
  /** 已发出、尚未返回的 turn/start 数。 */
  startsInFlight: number;
  /** turn/start 响应返回的回合 id。 */
  clientTurnIds: Set<string>;
  /** 等待判定 initiatedBy 的回合。 */
  deferred: Map<string, DeferredTurn>;
}

export interface CodexAppServerClientOptions {
  now?: () => number;
}

type Supervisor = Pick<AppServerSupervisor, "call" | "on" | "generation">;

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;

/** 服务端对过期/缺失活动回合的 turn/steer 报错（0.164.0-alpha.8 二进制中的文案）。 */
const NO_ACTIVE_TURN = [/no active turn to steer/i, /expected active turn id/i];
const NOT_STEERABLE = [/cannot steer a .* turn/i];
const THREAD_NOT_LOADED = [/thread not found/i, /thread not loaded/i];

function errorMatches(error: unknown, patterns: RegExp[]): boolean {
  return error instanceof RpcError && patterns.some(p => p.test(error.serverMessage));
}
function isNotSteerable(error: unknown): boolean {
  if (!(error instanceof RpcError)) return false;
  const data = object(error.data);
  const info = object(data.codexErrorInfo ?? object(data.error).codexErrorInfo);
  return Object.hasOwn(info, "activeTurnNotSteerable") || errorMatches(error, NOT_STEERABLE);
}
function turnError(value: unknown): TurnError | undefined {
  const e = object(value);
  if (typeof e.message !== "string") return undefined;
  return {
    message: e.message,
    ...(e.codexErrorInfo !== undefined && e.codexErrorInfo !== null ? { codexErrorInfo: e.codexErrorInfo } : {}),
    ...(e.additionalDetails !== undefined ? { additionalDetails: e.additionalDetails as string | null } : {}),
  };
}

export class CodexAppServerClient extends EventEmitter<ClientEvents> {
  private readonly threads = new Map<string, ThreadState>();
  /** 子 agent 线程 → 直接父线程。 */
  private readonly parents = new Map<string, string>();
  /** 已上报的 subAgentActivity（有界）。 */
  private readonly seenActivities = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly supervisor: Supervisor, opts: CodexAppServerClientOptions = {}) {
    super();
    this.now = opts.now ?? Date.now;
    supervisor.on("notification", (method, params) => this.onNotification(method, params));
    supervisor.on("down", event => this.onDown(event));
    supervisor.on("restarted", generation => this.emit("restarted", generation));
  }

  /** thread/start，返回新线程 id。 */
  async startThread(opts: ThreadOptions = {}, call: CallOptions = {}): Promise<string> {
    const { result, generation } = await this.supervisor.call("thread/start", this.threadParams(opts), this.callOpts(call));
    const threadId = str(object(object(result).thread).id);
    if (!threadId) throw new Error("codex app-server thread/start 响应缺少线程 id");
    this.markLoaded(threadId, generation);
    return threadId;
  }

  /** thread/resume（进程启动或重启后、首次在该线程开回合前调用）。返回线程 id。 */
  async resumeThread(threadId: string, opts: ThreadOptions = {}, call: CallOptions = {}): Promise<string> {
    const { result, generation } = await this.supervisor.call("thread/resume",
      { threadId, ...this.threadParams(opts) }, this.callOpts(call));
    const id = str(object(object(result).thread).id) ?? threadId;
    this.markLoaded(id, generation);
    return id;
  }

  /** turn/start，返回回合 id。线程未加载时抛 ThreadNotLoadedError。 */
  async startTurn(threadId: string, input: UserInput[], opts: TurnOptions & CallOptions = {}): Promise<string> {
    const state = this.requireLoaded(threadId);
    state.startsInFlight++;
    let turnId: string | undefined;
    try {
      const { result } = await this.supervisor.call("turn/start", {
        threadId, input: this.input(input),
        ...(opts.effort ? { effort: opts.effort } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.clientUserMessageId ? { clientUserMessageId: opts.clientUserMessageId } : {}),
      }, this.callOpts(opts));
      turnId = str(object(object(result).turn).id);
      if (!turnId) throw new Error("codex app-server turn/start 响应缺少回合 id");
      state.clientTurnIds.add(turnId);
      return turnId;
    } catch (error) {
      if (errorMatches(error, THREAD_NOT_LOADED)) { state.loadedGeneration = undefined; throw new ThreadNotLoadedError(threadId); }
      throw error;
    } finally {
      state.startsInFlight--;
      this.flushDeferred(state);
    }
  }

  /** turn/steer：把输入送进 expectedTurnId 对应的进行中回合。 */
  async steer(threadId: string, expectedTurnId: string, input: UserInput[], call: CallOptions & { clientUserMessageId?: string } = {}): Promise<SteerResult> {
    const state = this.requireLoaded(threadId);
    try {
      await this.supervisor.call("turn/steer", { threadId, expectedTurnId, input: this.input(input),
        ...(call.clientUserMessageId ? { clientUserMessageId: call.clientUserMessageId } : {}) }, this.callOpts(call));
      state.lastActivityAt = this.now();
      return "ok";
    } catch (error) {
      if (errorMatches(error, NO_ACTIVE_TURN)) return "no_active_turn";
      if (isNotSteerable(error)) return "not_steerable";
      if (errorMatches(error, THREAD_NOT_LOADED)) { state.loadedGeneration = undefined; throw new ThreadNotLoadedError(threadId); }
      throw error;
    }
  }

  /** turn/interrupt；回合结束仍以 turn/completed（status=interrupted）上报。 */
  async interrupt(threadId: string, turnId: string, call: CallOptions = {}): Promise<void> {
    this.requireLoaded(threadId);
    await this.supervisor.call("turn/interrupt", { threadId, turnId }, this.callOpts(call));
  }

  /**
   * thread/compact/start：压缩线程上下文。压缩以服务端开启的回合进行（turnStarted initiatedBy=server），
   * 调用方据此区分压缩回合与唤醒回合。线程未加载时抛 ThreadNotLoadedError。
   */
  async compactThread(threadId: string, call: CallOptions = {}): Promise<void> {
    const state = this.requireLoaded(threadId);
    try {
      await this.supervisor.call("thread/compact/start", { threadId }, this.callOpts(call));
    } catch (error) {
      if (errorMatches(error, THREAD_NOT_LOADED)) { state.loadedGeneration = undefined; throw new ThreadNotLoadedError(threadId); }
      throw error;
    }
  }

  /** 中止子 agent 线程的回合（子线程不经 start/resume 加载，不做已加载检查）。 */
  async interruptChild(threadId: string, turnId: string, call: CallOptions = {}): Promise<void> {
    await this.supervisor.call("turn/interrupt", { threadId, turnId }, this.callOpts(call));
  }

  thread(threadId: string): ThreadSnapshot | undefined {
    const state = this.threads.get(threadId);
    return state && this.snapshot(state);
  }

  listThreads(): ThreadSnapshot[] {
    return [...this.threads.values()].map(state => this.snapshot(state));
  }

  /** 不再跟踪该线程（线程轮换后）；不会通知服务端。 */
  forgetThread(threadId: string): void {
    this.threads.delete(threadId);
    for (const [child, parent] of this.parents) if (parent === threadId) this.parents.delete(child);
  }

  private snapshot(state: ThreadState): ThreadSnapshot {
    return {
      threadId: state.threadId,
      loaded: state.loadedGeneration !== undefined && state.loadedGeneration === this.supervisor.generation,
      ...(state.activeTurnId ? { activeTurnId: state.activeTurnId } : {}),
      lastActivityAt: state.lastActivityAt,
    };
  }

  private threadParams(opts: ThreadOptions): Record<string, unknown> {
    const config = { ...opts.config, ...(opts.modelInstructionsFile ? { model_instructions_file: opts.modelInstructionsFile } : {}) };
    return {
      approvalPolicy: opts.approvalPolicy ?? "never",
      ...(opts.sandbox === null ? {} : { sandbox: opts.sandbox ?? "workspace-write" }),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.baseInstructions !== undefined ? { baseInstructions: opts.baseInstructions } : {}),
      ...(opts.developerInstructions !== undefined ? { developerInstructions: opts.developerInstructions } : {}),
      ...(Object.keys(config).length ? { config } : {}),
    };
  }

  private input(input: UserInput[]): unknown[] {
    return input.map(part => part.type === "text"
      ? { type: "text", text: part.text, text_elements: [] }
      : { type: "localImage", path: part.path });
  }

  private callOpts(call: CallOptions): SupervisedRequestOptions {
    return { ...(call.signal ? { signal: call.signal } : {}), ...(call.timeoutMs !== undefined ? { timeoutMs: call.timeoutMs } : {}) };
  }

  private state(threadId: string): ThreadState {
    let state = this.threads.get(threadId);
    if (!state) {
      state = { threadId, lastActivityAt: this.now(), startsInFlight: 0, clientTurnIds: new Set(), deferred: new Map() };
      this.threads.set(threadId, state);
    }
    return state;
  }

  private markLoaded(threadId: string, generation: number): void {
    const state = this.state(threadId);
    // 响应返回前进程已重启：这次加载属于旧进程，不能算数。
    if (generation !== this.supervisor.generation) throw new ThreadNotLoadedError(threadId);
    this.parents.delete(threadId);
    state.loadedGeneration = generation;
    state.lastActivityAt = this.now();
  }

  private requireLoaded(threadId: string): ThreadState {
    const state = this.threads.get(threadId);
    if (!state || state.loadedGeneration === undefined || state.loadedGeneration !== this.supervisor.generation) {
      throw new ThreadNotLoadedError(threadId);
    }
    return state;
  }

  /** 沿子 agent 映射找到我们跟踪的根线程（防环，最多 32 层）。 */
  private rootOf(threadId: string): string | undefined {
    let id = threadId;
    for (let depth = 0; depth < 32; depth++) {
      if (this.threads.has(id) && !this.parents.has(id)) return id;
      const parent = this.parents.get(id);
      if (!parent) return undefined;
      id = parent;
    }
    return undefined;
  }

  private onNotification(method: string, raw: unknown): void {
    const params = object(raw);
    if (method === "thread/started") {
      const thread = object(params.thread);
      const id = str(thread.id);
      const parent = str(thread.parentThreadId);
      if (id && parent && !this.threads.has(id)) this.parents.set(id, parent);
      return;
    }
    const threadId = str(params.threadId);
    if (!threadId) return;
    const own = this.threads.get(threadId);
    if (!own) {
      const root = this.rootOf(threadId);
      if (root) {
        // 子 agent 再派出的孙线程同样挂到映射上，事件最终归到根父线程。
        const item = object(params.item);
        const grandchild = str(item.agentThreadId);
        if (item.type === "subAgentActivity" && grandchild && !this.threads.has(grandchild)) this.parents.set(grandchild, threadId);
        this.threads.get(root)!.lastActivityAt = this.now();
        const turnId = str(object(params.turn).id) ?? str(params.turnId);
        this.emit("childActivity", { parentThreadId: root, agentThreadId: threadId, method, ...(turnId ? { turnId } : {}) });
      }
      return;
    }
    own.lastActivityAt = this.now();
    switch (method) {
      case "turn/started": return this.onTurnStarted(own, object(params.turn));
      case "turn/completed": return this.onTurnCompleted(own, object(params.turn));
      case "item/started":
      case "item/completed": return this.onItem(own, method === "item/started" ? "started" : "completed", params);
      case "error": {
        const error = turnError(params.error);
        this.emit("turnError", {
          threadId: own.threadId, willRetry: params.willRetry === true,
          ...(str(params.turnId) ? { turnId: str(params.turnId)! } : {}),
          ...(error ? { error } : {}),
        });
        return;
      }
      default: return;
    }
  }

  private onTurnStarted(state: ThreadState, turn: Record<string, unknown>): void {
    const turnId = str(turn.id);
    if (!turnId) return;
    state.activeTurnId = turnId;
    if (state.clientTurnIds.has(turnId)) return void this.emit("turnStarted", { threadId: state.threadId, turnId, initiatedBy: "client" });
    if (state.startsInFlight > 0) {
      state.deferred.set(turnId, { started: { threadId: state.threadId, turnId, initiatedBy: "server" } });
      return;
    }
    this.emit("turnStarted", { threadId: state.threadId, turnId, initiatedBy: "server" });
  }

  private onTurnCompleted(state: ThreadState, turn: Record<string, unknown>): void {
    const turnId = str(turn.id);
    if (!turnId) return;
    if (state.activeTurnId === turnId) state.activeTurnId = undefined;
    const status = (str(turn.status) ?? "failed") as TurnStatus;
    const error = turnError(turn.error);
    const event: TurnCompletedEvent = { threadId: state.threadId, turnId, status, ...(error ? { error } : {}) };
    const deferred = state.deferred.get(turnId);
    if (deferred) { deferred.completed = event; return; }
    state.clientTurnIds.delete(turnId);
    this.emit("turnCompleted", event);
  }

  private onItem(state: ThreadState, phase: "started" | "completed", params: Record<string, unknown>): void {
    const item = object(params.item) as ThreadItem;
    if (typeof item.type !== "string") return;
    const turnId = str(params.turnId);
    this.emit("item", { threadId: state.threadId, phase, item, ...(turnId ? { turnId } : {}) });
    if (item.type !== "subAgentActivity") return;
    const agentThreadId = str(item.agentThreadId);
    const kind = str(item.kind);
    if (!agentThreadId || !kind) return;
    if (!this.threads.has(agentThreadId)) this.parents.set(agentThreadId, state.threadId);
    // 同一条活动可能先后以 item/started、item/completed 出现；按 item id 去重，只上报一次。
    const key = `${state.threadId}:${item.id ?? `${agentThreadId}:${kind}`}`;
    if (this.seenActivities.has(key)) return;
    this.seenActivities.add(key);
    if (this.seenActivities.size > 1_000) this.seenActivities.delete(this.seenActivities.values().next().value!);
    this.emit("subAgent", { parentThreadId: state.threadId, kind, agentThreadId, item });
  }

  /** 没有未返回的 turn/start 时，暂存回合按响应拿到的 id 判定发起方并补发事件。 */
  private flushDeferred(state: ThreadState): void {
    for (const [turnId, deferred] of state.deferred) {
      const client = state.clientTurnIds.has(turnId);
      if (!client && state.startsInFlight > 0) continue;
      state.deferred.delete(turnId);
      this.emit("turnStarted", { ...deferred.started, initiatedBy: client ? "client" : "server" });
      if (deferred.completed) {
        state.clientTurnIds.delete(turnId);
        this.emit("turnCompleted", deferred.completed);
      }
    }
  }

  private onDown(event: DownEvent): void {
    this.parents.clear();
    this.seenActivities.clear();
    for (const state of this.threads.values()) {
      // 暂存的回合先补发 started，保证 started → lost 的顺序。
      for (const [turnId, deferred] of state.deferred) {
        this.emit("turnStarted", { ...deferred.started, initiatedBy: state.clientTurnIds.has(turnId) ? "client" : "server" });
        if (deferred.completed) this.emit("turnCompleted", deferred.completed);
      }
      state.deferred.clear();
      state.clientTurnIds.clear();
      state.loadedGeneration = undefined;
      const turnId = state.activeTurnId;
      state.activeTurnId = undefined;
      if (turnId) this.emit("turnLost", { threadId: state.threadId, turnId, reason: event.reason });
    }
  }
}

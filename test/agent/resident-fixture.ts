/**
 * 常驻 agent 的集成测试装置（设计 §4、§6、§7、§8）：真实 ReplyStore / bridge（假 OneBot 客户端）、
 * ThreadHost（派发 harness）、Inbox、pi 后端（faux 模型）与 codex 适配层（假 runner），可模拟重启。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getSystemMessageText, type FauxResponseFactory, type Message, type TranscriptContext } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type JsonObject, type ModelRef } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, vi } from "vitest";
import { PiBackend, type PiBackendOptions } from "../../src/agent/backends/pi.js";
import { ContextUsageStore } from "../../src/agent/context-usage.js";
import { CodexBackend } from "../../src/agent/backends/codex.js";
import type { BackendName, SettingsSnapshot } from "../../src/agent/backends/types.js";
import { GrantsService } from "../../src/agent/grants.js";
import { ThreadHost } from "../../src/agent/host/thread-host.js";
import type { ThreadKey } from "../../src/agent/host/types.js";
import { Inbox } from "../../src/agent/inbox.js";
import { SendService } from "../../src/agent/send-service.js";
import { BackendRouter, TurnMonitor } from "../../src/agent/turns.js";
import { threadKeyOf } from "../../src/channel/inbound.js";
import type { InboundMessage } from "../../src/channel/types.js";
import { ContextStore } from "../../src/context/store.js";
import { createQQBridge } from "../../src/qq/bridge.js";
import type { ReplyStore } from "../../src/qq/reply-store.js";
import { CodexRunner } from "../../src/agent/codex/runner.js";
import { startMediaRecallServer, ThreadTokens, type CallMeta } from "../../src/context/media-recall-server.js";
import { sendViaLoopback } from "../../src/mcp/im-server.js";
import { contextViaLoopback } from "../../src/mcp/media-recall-client.js";
import { CodexScript } from "./codex-fixture.js";
import { fakeSpawn } from "./codex-app-server/fake-app-server.js";
import type { SubagentOptions } from "../../src/agent/pi-tools/subagent.js";
import { DEFAULT_SUBAGENT_INSTRUCTIONS } from "../../src/agent/pi-tools/subagent.js";
import { FIXTURES, tmp } from "./helpers.js";
import { sandboxRequirements } from "./pi-sandbox-fixture.js";

export const context = BACKGROUND_CONTEXT;
const rigs: { close(): Promise<void> }[] = [];
afterEach(async () => { for (const r of rigs.splice(0).reverse()) await r.close(); vi.unstubAllEnvs(); });

export const text = (m: Message | undefined) => !m ? "" : m.role === "system" ? getSystemMessageText(m)
  : typeof m.content === "string" ? m.content : m.content.map(c => c.type === "text" ? c.text : "").join("");
export const lastUser = (ctx: TranscriptContext) => text(ctx.messages.filter(m => m.role === "user").at(-1));
export const isChild = (ctx: TranscriptContext) => ctx.messages.some(m => m.role === "system" && text(m).includes(DEFAULT_SUBAGENT_INSTRUCTIONS));
export const call = (...calls: [string, JsonObject][]) => fauxAssistantMessage(calls.map(([name, args]) => fauxToolCall(name, args)), { stopReason: "toolUse" });
export const reply = (body = "好的") => fauxAssistantMessage(body);
export const toolResults = (ctx: TranscriptContext) => ctx.messages.filter(m => m.role === "toolResult").map(m => text(m));

/** extra：本次请求的模型与选项（运行时模型设置测试用）。 */
export type Brain = (ctx: TranscriptContext, signal: AbortSignal | undefined, extra?: { model: string; reasoning: unknown }) => Message | Promise<Message>;

/** 可中止的闸门：faux 回应等它打开；生成被中止时随之拒绝，避免关闭 harness 时挂起。 */
export function gate() {
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  let entered = 0;
  return { open, get entered() { return entered; }, wait: (signal?: AbortSignal) => {
    entered++;
    return new Promise<void>((resolve, reject) => {
      void opened.then(resolve);
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  } };
}

export interface ResidentOptions {
  brain?: Brain;
  owners?: string[];
  backend?: BackendName | ((scope: string) => BackendName);
  concurrency?: number;
  /** codex 回合脚本（内存版 app-server）；缺省每轮立即完成 */
  codex?: CodexScript;
  /** 工具调用等待回合事件的上限（缺省 1 秒） */
  callWaitMs?: number;
  subagent?: Partial<Omit<SubagentOptions, "getHarness" | "initChild">> | false;
  noticeIntervalMs?: number;
  now?: () => number;
  stallMs?: number;
  /** 以下透传给 PiBackend.open（缺省与原装置一致） */
  workspaceDir?: string;
  skillsDir?: string;
  mediaRecall?: PiBackendOptions["mediaRecall"];
  channel?: PiBackendOptions["channel"];
  scheduleTools?: PiBackendOptions["scheduleTools"];
  instrumentation?: PiBackendOptions["instrumentation"];
  web?: PiBackendOptions["web"];
  currentModel?: (provider: string) => ModelRef;
  /** 额外的 faux 模型（运行时模型设置） */
  extraModels?: { id: string; contextWindow?: number; reasoning?: boolean }[];
  vision?: boolean;
  /** true：接入 ContextUsageStore（dir/context-usage.json） */
  contextUsage?: boolean;
  reserveTokens?: number;
  backgroundTokens?: number;
  /** 开轮时的设置快照覆盖（模型、档位） */
  settings?: (scope: string) => Partial<SettingsSnapshot>;
  /** 预先放进数据目录的文件（PiBackend 打开前） */
  dir?: string;
}

let messageSeq = 1000;

export async function residentRig(options: ResidentOptions = {}) {
  const dir = await fs.realpath(options.dir ?? tmp("cs-resident-"));
  vi.stubEnv("CODEX_REQUIREMENTS_FILE", await sandboxRequirements(dir));
  const owners = options.owners ?? ["1", "9"];
  const brain = { current: options.brain ?? (() => reply()) };
  const faux = fauxProvider({ models: [{ id: "test", contextWindow: 200_000, input: options.vision ? ["text", "image"] : ["text"] },
    ...(options.extraModels ?? [])], tokensPerSecond: Infinity });
  const step: FauxResponseFactory = async (ctx, opts, _state, m) =>
    await brain.current(ctx, opts?.signal, { model: m.id, reasoning: opts?.reasoning }) as ReturnType<typeof fauxAssistantMessage>;
  faux.setResponses(Array.from({ length: 500 }, () => step));
  const models = createModels(); models.setProvider(faux.provider);
  const model = faux.getModel();
  const sent: { action: string; params: Record<string, unknown> }[] = [];
  let n = 0;
  const call = vi.fn(async (action: string, params: Record<string, unknown> = {}) => {
    if (action === "get_login_info") return { user_id: 2 };
    if (action.startsWith("upload_")) return { file_id: "file-" + ++n };
    if (action === "get_group_list") return [{ group_id: 7, group_name: "群七" }, { group_id: 8, group_name: "群八" }];
    if (action === "get_friend_list") return [{ user_id: 1, nickname: "主人" }, { user_id: 5, nickname: "五" }];
    sent.push({ action, params });
    return { message_id: String(++n) };
  });
  const bridge = createQQBridge({ httpUrl: "http://unused.test", wsUrl: "ws://unused.test", token: "",
    allowUsers: ["5", "6", "7"], owners, allowGroups: ["7", "8"], groupMentions: true, dataDir: dir,
    imageRoot: path.join(dir, "images") }, { client: { call } });
  const history = new ContextStore(dir);
  const script = options.codex ?? new CodexScript();
  const codexSpawn = fakeSpawn(script.handlers);

  let harness!: Harness, host!: ThreadHost, pi!: PiBackend, codex!: CodexBackend, monitor!: TurnMonitor;
  let codexRunner!: CodexRunner;
  let contextUsage: ContextUsageStore | undefined;
  const grants = new GrantsService({ getHarness: () => harness, owner: owners[0], owners });
  const sendService = new SendService({ grants, getChannel: () => bridge, dataDir: dir, store: history,
    mention: key => host.takeMention(key as ThreadKey) });
  const inbox = new Inbox({ getChannel: () => bridge, getHost: () => host, owners, store: history, dataDir: dir });
  // codex 线程令牌与 loopback 网关（与 main.ts 一致）：每次调用由 codex 适配器确认属于宿主当前回合
  const tokens = new ThreadTokens({ recall: async () => ({ text: "", images: [] }) }, {
    resolve: (threadKey, meta) => codex.resolveCall(threadKey as ThreadKey, meta),
    permissions: async binding => grants.permissions(binding),
    auth: (binding, name, args) => grants.tool(binding, name, args),
    send: (binding, callKey, args, signal) => sendService.send({ ...binding, extraRoots: [binding.imageDir] }, args, callKey, signal),
  });
  const recallServer = await startMediaRecallServer(tokens, 0);
  const backendOf = (scope: string): BackendName => typeof options.backend === "function" ? options.backend(scope) : options.backend ?? "pi";

  const open = async () => {
    harness = await Harness.open(await openNodeSqliteStorage(path.join(dir, "agent.sqlite")), { registry: createRegistry(), models: createModels() }, context);
    if (options.contextUsage) contextUsage = new ContextUsageStore(dir);
    pi = await PiBackend.open({ sendService, grants, turns: inbox, owners, dataDir: dir, workspaceDir: options.workspaceDir ?? path.join(dir, "codex-work"),
      models, model: { provider: model.provider, modelId: model.id }, thinkingLevel: "off", store: history,
      subagent: options.subagent ?? { maxConcurrent: 3 },
      ...(options.skillsDir !== undefined ? { skillsDir: options.skillsDir } : {}),
      ...(options.mediaRecall ? { mediaRecall: options.mediaRecall } : {}),
      ...(options.channel ? { channel: options.channel } : {}),
      ...(options.scheduleTools ? { scheduleTools: options.scheduleTools } : {}),
      ...(options.instrumentation ? { instrumentation: options.instrumentation } : {}),
      ...(options.web ? { web: options.web } : {}),
      ...(options.currentModel ? { currentModel: () => options.currentModel!(model.provider) } : {}),
      ...(contextUsage ? { contextUsage } : {}),
      ...(options.reserveTokens !== undefined ? { reserveTokens: options.reserveTokens } : {}),
      ...(options.backgroundTokens !== undefined ? { backgroundTokens: options.backgroundTokens } : {}) });
    codexRunner = new CodexRunner({ command: [process.execPath, path.join(FIXTURES, "fake-codex.mjs")],
      codexHome: path.join(dir, "codex"), workspaceDir: path.join(dir, "codex-ws"), threadsFile: path.join(dir, "codex-threads.json"),
      sandbox: "workspace-write", mediaRecallPort: recallServer.port, spawn: codexSpawn.spawn,
      supervisor: { backoffInitialMs: 5, backoffMaxMs: 20, readyTimeoutMs: 5_000 } });
    await codexRunner.start();
    codex = new CodexBackend({ runner: codexRunner, tokens, imagesDir: path.join(dir, "images"), turns: inbox, owners,
      callWaitMs: options.callWaitMs ?? 1_000 });
    const settings = async (scope: string, _msg?: unknown, forced?: BackendName): Promise<SettingsSnapshot> =>
      ({ backend: forced ?? backendOf(scope), codexReasoningEffort: "high", ...options.settings?.(scope) });
    const router = new BackendRouter({ backends: { pi, codex }, settings, turns: inbox, owners, retryMs: 50, retryDelayMs: 10 });
    monitor = new TurnMonitor({ inbox, sendService, getHost: () => host, now: options.now,
      noticeIntervalMs: options.noticeIntervalMs, stallMs: options.stallMs });
    host = new ThreadHost({ store: harness, adapter: router, concurrency: options.concurrency ?? 4, owners, events: monitor.events, now: options.now });
    pi.bind(host);
    codex.attach(host);
    await host.recover();
    await pi.attach();
  };
  await open();

  const message = (user: string, body: string, group: string | null = "7", extra: Partial<InboundMessage> = {}): InboundMessage => ({
    message_id: String(++messageSeq), message_type: group ? "group" : "private", group_id: group, user_id: user, self_id: "2",
    nickname: "用户" + user, time: Math.floor(Date.now() / 1000), text: body, route_text: body, truncated: false,
    mentioned_self: !!group, images: [], segments: [], ...extra,
  });

  const r = {
    dir, bridge, history, grants, sendService, inbox, script, codexSpawn, tokens, sent, faux, brain, owners, model, call,
    get codexRunner() { return codexRunner; },
    get contextUsage() { return contextUsage; },
    get harness() { return harness; }, get host() { return host; }, get pi() { return pi; }, get codex() { return codex; }, get monitor() { return monitor; },
    message,
    /** 模拟 bridge 收到一条触发消息：去重落盘后交给 Inbox。返回入站键。 */
    async say(user: string, body: string, group: string | null = "7", extra: Partial<InboundMessage> = {}) {
      const msg = message(user, body, group, extra);
      const key = (bridge.inbox as ReplyStore).admit(msg, threadKeyOf(msg, owners))!;
      if (!key) throw new Error("重复消息");
      // 与 bridge 一致：触发消息先入库作上下文
      history.ingest(msg);
      await inbox.receive(msg, key);
      return key;
    },
    /** 会话线程当前的令牌（最近一次 thread/start、thread/resume 写入的 IM_TOKEN）。 */
    codexToken(threadKey: string): string {
      const loads = codexSpawn.children.flatMap(child => child.received.filter(m => m.id !== undefined &&
        (m.method === "thread/start" || m.method === "thread/resume")));
      const load = loads.filter(m => String((m.params as { cwd: string }).cwd).endsWith(threadKey.replace(":", "_"))).at(-1);
      if (!load) throw new Error("会话线程未加载：" + threadKey);
      return String((load.params as { config: Record<string, unknown> }).config["mcp_servers.im.env.IM_TOKEN"]);
    },
    /** 模拟 im MCP：以会话线程令牌和调用归属发送 */
    codexSend(threadKey: string, args: unknown, meta: CallMeta, token?: string) {
      return sendViaLoopback(args, meta, token ?? r.codexToken(threadKey), recallServer.port);
    },
    /** 模拟 qq_context / image_gen 取调用上下文 */
    codexContext(threadKey: string, meta: CallMeta, token?: string) {
      return contextViaLoopback(token ?? r.codexToken(threadKey), recallServer.port, meta);
    },
    /** 宿主空闲（没有进行中的回合与排队输入）且外层事件处理完毕。 */
    async idle(timeout = 10_000) {
      await vi.waitFor(async () => {
        await host.idle();
        const busy = host.status().busy;
        if (busy.length) throw new Error("busy: " + busy.join(","));
      }, { timeout, interval: 20 });
      await codex.idle();
      await monitor.idle();
    },
    texts(target?: string) {
      return sent.filter(s => !target || String(s.params.group_id ?? s.params.user_id) === target).map(s => {
        const segs = s.params.message as { type: string; data: Record<string, unknown> }[];
        return segs.filter(seg => seg.type === "text").map(seg => String(seg.data.text)).join("").replace(/^\n/, "");
      });
    },
    mentions() {
      return sent.map(s => (s.params.message as { type: string; data: Record<string, unknown> }[]).find(seg => seg.type === "at")?.data.qq ?? null);
    },
    /** 模拟进程重启：关闭两个 harness 后用同一数据库重开并恢复。 */
    async restart() {
      pi.beginShutdown();
      await harness.close(context);
      await pi.close();
      await contextUsage?.close();
      await codexRunner.stop();
      tokens.close();
      await open();
      await inbox.recover();
    },
    async close() {
      monitor.stopWatchdog();
      pi.beginShutdown();
      await harness.close(context).catch(() => undefined);
      await pi.close().catch(() => undefined);
      await contextUsage?.close().catch(() => undefined);
      await bridge.stop().catch(() => undefined);
      await codexRunner.stop().catch(() => undefined);
      await recallServer.close().catch(() => undefined);
      history.close();
    },
  };
  rigs.push(r);
  return r;
}

export type ResidentRig = Awaited<ReturnType<typeof residentRig>>;

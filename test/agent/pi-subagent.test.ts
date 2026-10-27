import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, Type, type FauxResponseFactory, type Message, type TranscriptContext } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness, type Conversation, type ConversationId, type EntryRecord, type JsonObject, type Storage, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSubagentExtension, isSubagentExcludedTool, isSubagentReportRequest, SUBAGENT_REPORT_KIND,
  SUBAGENT_REPORT_REQUEST_PREFIX, SubagentDoc, type SubagentOptions } from "../../src/agent/pi-tools/subagent.js";
import { tmp } from "./helpers.js";
import { call, gate, isChild, lastUser, text, toolResults } from "./faux-helpers.js";

const context = BACKGROUND_CONTEXT;
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

/** 父会话可见的全部工具；子会话应只剩 echo 与 web_search。 */
const PARENT_TOOLS = ["echo", "web_search", "send_message", "auth_grant", "auth_list", "schedule_create", "schedule_control", "mcp_docs_lookup_123456789abc"];
const MCP_CALLABLE = "mcp_docs_internal_123456789abc";
const last = (ctx: TranscriptContext) => ctx.messages.at(-1)!;

type Brain = (ctx: TranscriptContext, signal: AbortSignal | undefined) => Message | Promise<Message>;

async function rig(brain: { current: Brain }, opts: { storage?: Storage; subagent?: Partial<SubagentOptions> } = {}) {
  const faux = fauxProvider({ models: [{ id: "test" }, { id: "child" }], tokensPerSecond: Infinity });
  const step: FauxResponseFactory = async (ctx, options) => await brain.current(ctx, options?.signal) as ReturnType<typeof fauxAssistantMessage>;
  faux.setResponses(Array.from({ length: 300 }, () => step));
  const models = createModels(); models.setProvider(faux.provider);
  const registry = createRegistry();
  const stub = (name: string) => defineTool({ name, description: name, parameters: Type.Object({}), execute: async () => ({ output: [{ type: "text" as const, text: name + " ok" }] }) });
  const base = defineExtension({ name: "base", tools: [...PARENT_TOOLS.map(stub), defineTool({ ...stub(MCP_CALLABLE), callers: ["tools"] })] });
  let harness!: Harness;
  const subagent = createSubagentExtension({ getHarness: () => harness, ...opts.subagent });
  registry.install(base); registry.install(subagent);
  harness = await Harness.open(opts.storage ?? await openNodeSqliteStorage(path.join(tmp("cs-subagent-"), "pi.sqlite")),
    { models, registry, settings: { toolExecution: "sequential", retry: { maxRetries: 0 } } }, context);
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await harness.close(context); } };
  cleanup.push(close);
  const model = { provider: faux.getModel().provider, modelId: "test" };
  return { harness, faux, model, close };
}

async function entries(conv: Conversation): Promise<EntryRecord[]> {
  return (await conv.entries({ order: "ascending" }, 1000, undefined, context)).items as EntryRecord[];
}
const reports = async (conv: Conversation) => (await entries(conv)).filter(e => e.kind === SUBAGENT_REPORT_KIND);
const assistantTexts = async (conv: Conversation) => (await entries(conv)).filter(e => e.kind === "pi.assistant").map(e => text(e.model?.[0]));
const doc = async (harness: Harness, conv: Conversation) => (await harness.snapshot(SubagentDoc, conv.id, context))!;
const child = async (harness: Harness, conv: Conversation, name: string) =>
  (await harness.conversation((await doc(harness, conv)).children[name]!.conversation as ConversationId, context))!;

/** 父会话的默认脚本：收到用户指令就调用对应工具；工具结果后简短收尾；收到汇报就复述。 */
function parentBrain(commands: Record<string, [string, JsonObject][]>, seen: string[][] = []) {
  return (ctx: TranscriptContext) => {
    const end = last(ctx);
    if (end.role === "toolResult") { seen.push(toolResults(ctx)); return fauxAssistantMessage("好的"); }
    const input = lastUser(ctx);
    if (input.startsWith("[子 agent ")) return fauxAssistantMessage("收到：" + input);
    const calls = commands[input];
    return calls ? call(...calls) : fauxAssistantMessage("？");
  };
}

describe("pi 子 agent 扩展", () => {
  it("排除名单：subagent、send_message、auth_*、schedule_* 不给子会话", () => {
    for (const name of ["subagent", "send_message", "auth_grant", "auth_revoke", "auth_list", "schedule_create", "schedule_control", "schedule_whatever", "mcp_unknown_history", MCP_CALLABLE])
      expect(isSubagentExcludedTool(name), name).toBe(true);
    for (const name of ["echo", "web_search", "qq_recent", "generate_image", "bash", "read"]) expect(isSubagentExcludedTool(name), name).toBe(false);
    const allowed = new Set([PARENT_TOOLS.at(-1)!, MCP_CALLABLE, "mcp_refresh_tools"]);
    for (const name of allowed) expect(isSubagentExcludedTool(name, name => allowed.has(name))).toBe(false);
    expect(isSubagentExcludedTool("mcp_other_secret", name => allowed.has(name))).toBe(true);
    expect(isSubagentExcludedTool("send_message", () => true)).toBe(true);
    expect(isSubagentReportRequest(SUBAGENT_REPORT_REQUEST_PREFIX + "3:e9")).toBe(true);
    expect(isSubagentReportRequest("ticket_1")).toBe(false);
  });

  it("spawn 后子会话独立运行，结果作为 follow-up 输入唤醒父会话新的一轮", async () => {
    const childSeen: TranscriptContext[] = [];
    const parent = parentBrain({ 开始: [["subagent", { action: "spawn", name: "r1", task: "查一下天气" }]] });
    const brain = { current: ((ctx: TranscriptContext) => {
      if (isChild(ctx)) { childSeen.push(ctx); return fauxAssistantMessage("晴，25 度"); }
      return parent(ctx);
    }) as Brain };
    const { harness, model } = await rig(brain);
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
    const first = await (await conv.submit({ type: "input", content: "开始" }, context)).wait(context);
    expect(first.status).toBe("done");
    await vi.waitFor(async () => expect(await assistantTexts(conv)).toContain("收到：[子 agent 完成] r1：晴，25 度"), { timeout: 5000 });

    const [report] = await reports(conv);
    expect(report.data).toMatchObject({ name: "r1", status: "done" });
    expect(text(report.model?.[0])).toBe("[子 agent 完成] r1：晴，25 度");
    const answer = (await entries(await child(harness, conv, "r1"))).find(e => e.kind === "pi.assistant")!.id;
    const requestId = `${SUBAGENT_REPORT_REQUEST_PREFIX}${(report.data as { child: number }).child}:e${answer}`;
    const submission = await conv.commit(tx => tx.submissionByRequest(conv.id, requestId), context);
    expect(submission).toMatchObject({ status: "done", entry: report.id });

    // 子会话：默认沿用父模型；工具集为父会话工具减去排除名单。
    const sub = await child(harness, conv, "r1");
    const agent = await sub.agent(context);
    expect(agent.model).toEqual(model);
    expect(agent.tools.map(t => t.name)).toEqual(["echo", "web_search"]);
    expect(agent.callable.map(t => t.name)).toEqual(["echo", "web_search"]);
    expect(childSeen[0]!.messages.some(m => m.role === "user" && text(m) === "查一下天气")).toBe(true);
    expect((await doc(harness, conv)).children.r1).toMatchObject({ stopped: false, pending: [], last: { status: "done", text: "晴，25 度" } });
  });

  it("可覆盖子会话模型；status/list 返回登记", async () => {
    const seen: string[][] = [];
    const parent = parentBrain({ 开始: [["subagent", { action: "spawn", task: "算 1+1" }]], 看看: [["subagent", { action: "list" }], ["subagent", { action: "status", name: "sub-1" }]] }, seen);
    const models: string[] = [];
    const brain = { current: ((ctx: TranscriptContext) => isChild(ctx) ? fauxAssistantMessage("2") : parent(ctx)) as Brain };
    const { harness, model, faux } = await rig(brain, { subagent: { model: { provider: "faux", modelId: "child" } } });
    const step: FauxResponseFactory = async (ctx, _o, _s, m) => { models.push(m.id); return await brain.current(ctx, undefined) as ReturnType<typeof fauxAssistantMessage>; };
    faux.setResponses(Array.from({ length: 50 }, () => step));
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
    await (await conv.submit({ type: "input", content: "开始" }, context)).wait(context);
    await vi.waitFor(async () => expect(await reports(conv)).toHaveLength(1), { timeout: 5000 });
    expect((await (await child(harness, conv, "sub-1")).agent(context)).model).toEqual({ provider: "faux", modelId: "child" });
    expect(models).toContain("child");
    await vi.waitFor(async () => expect((await harness.inspect(context)).submissions).toHaveLength(0), { timeout: 5000 });
    await (await conv.submit({ type: "input", content: "看看" }, context)).wait(context);
    expect(seen.at(-1)!.slice(-2)).toEqual(["sub-1（空闲）任务：算 1+1，最近结果：2", "sub-1（空闲）任务：算 1+1，最近结果：2"]);
  });

  it("子 agent 失败时汇报失败原因", async () => {
    const parent = parentBrain({ 开始: [["subagent", { action: "spawn", name: "bad", task: "会失败" }]] });
    const brain = { current: ((ctx: TranscriptContext) => isChild(ctx)
      ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "上游拒绝请求" }) : parent(ctx)) as Brain };
    const { harness, model } = await rig(brain);
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
    await (await conv.submit({ type: "input", content: "开始" }, context)).wait(context);
    await vi.waitFor(async () => expect(await reports(conv)).toHaveLength(1), { timeout: 5000 });
    const [report] = await reports(conv);
    expect(report.data).toMatchObject({ name: "bad", status: "failed" });
    expect(text(report.model?.[0])).toMatch(/^\[子 agent 失败\] bad：model_error/);
    await vi.waitFor(async () => expect((await doc(harness, conv)).children.bad).toMatchObject({ pending: [], last: { status: "failed" } }), { timeout: 5000 });
  });

  it("父会话中止不会波及子 agent，子 agent 完成后仍汇报并唤醒父会话", async () => {
    const childGate = gate(), parentGate = gate();
    const parent = parentBrain({ 开始: [["subagent", { action: "spawn", name: "slow", task: "慢慢查" }]] });
    const brain = { current: (async (ctx: TranscriptContext, signal: AbortSignal | undefined) => {
      if (isChild(ctx)) { await childGate.wait(signal); return fauxAssistantMessage("查完了"); }
      // 工具结果后的那一步挂起，模拟父会话还在忙时被用户中止。
      if (last(ctx).role === "toolResult") { await parentGate.wait(signal); }
      return parent(ctx);
    }) as Brain };
    const { harness, model } = await rig(brain);
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
    const submission = await conv.submit({ type: "input", content: "开始" }, context);
    await vi.waitFor(() => { expect(parentGate.entered).toBe(1); expect(childGate.entered).toBe(1); }, { timeout: 5000 });
    await conv.abort(context);
    expect((await submission.wait(context)).status).toBe("unanswered");
    const anchor = (await doc(harness, conv)).children.slow!.anchor;
    expect((await harness.getTask(anchor as unknown as TaskId, context))!.state.status).not.toBe("terminal");
    childGate.open();
    await vi.waitFor(async () => expect(await assistantTexts(conv)).toContain("收到：[子 agent 完成] slow：查完了"), { timeout: 5000 });
    expect(await reports(conv)).toHaveLength(1);
  });

  it("子 agent 进行中重启：子会话续跑并且只汇报一次", async () => {
    const dir = tmp("cs-subagent-restart-");
    const childGate = gate();
    const parent = parentBrain({ 开始: [["subagent", { action: "spawn", name: "r", task: "长任务" }]] });
    let childCalls = 0;
    const brain = { current: (async (ctx: TranscriptContext, signal: AbortSignal | undefined) => {
      if (isChild(ctx)) { childCalls++; await childGate.wait(signal); return fauxAssistantMessage("不应出现"); }
      return parent(ctx);
    }) as Brain };
    const first = await rig(brain, { storage: await openNodeSqliteStorage(path.join(dir, "pi.sqlite")) });
    const conv = await first.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: first.model } }, context);
    await (await conv.submit({ type: "input", content: "开始" }, context)).wait(context);
    await vi.waitFor(() => expect(childGate.entered).toBe(1), { timeout: 5000 });
    await first.close();

    brain.current = (ctx: TranscriptContext) => {
      if (isChild(ctx)) { childCalls++; return fauxAssistantMessage("重启后完成"); }
      return parent(ctx);
    };
    const second = await rig(brain, { storage: await openNodeSqliteStorage(path.join(dir, "pi.sqlite")) });
    second.harness.resume();
    const again = (await second.harness.conversation(conv.id, context))!;
    await vi.waitFor(async () => expect(await assistantTexts(again)).toContain("收到：[子 agent 完成] r：重启后完成"), { timeout: 5000 });
    await vi.waitFor(async () => expect((await second.harness.inspect(context)).submissions).toHaveLength(0), { timeout: 5000 });
    expect(await reports(again)).toHaveLength(1);
    expect(childCalls).toBe(2);
    const sub = await child(second.harness, again, "r");
    expect((await entries(sub)).filter(e => e.kind === "pi.user")).toHaveLength(1);
    const owned = await second.harness.commit(tx => tx.scanConversations({ ownerConversationId: conv.id }, 10), context);
    expect(owned.items).toHaveLength(1);
    expect((await doc(second.harness, again)).children.r).toMatchObject({ pending: [], last: { text: "重启后完成" } });
  });

  it("stop 中止子会话与未完成的汇报，不再汇报并释放名额", async () => {
    const childGate = gate();
    const seen: string[][] = [];
    const parent = parentBrain({
      开始: [["subagent", { action: "spawn", name: "x", task: "永远做不完" }]],
      停止: [["subagent", { action: "stop", name: "x" }], ["subagent", { action: "message", name: "x", task: "还在吗" }], ["subagent", { action: "status", name: "x" }]],
      再派: [["subagent", { action: "spawn", name: "x", task: "新任务" }]],
    }, seen);
    const brain = { current: (async (ctx: TranscriptContext, signal: AbortSignal | undefined) => {
      if (isChild(ctx)) {
        if (lastUser(ctx) === "新任务") return fauxAssistantMessage("新结果");
        await childGate.wait(signal); return fauxAssistantMessage("不应出现");
      }
      return parent(ctx);
    }) as Brain };
    const { harness, model } = await rig(brain, { subagent: { maxConcurrent: 1 } });
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
    await (await conv.submit({ type: "input", content: "开始" }, context)).wait(context);
    await vi.waitFor(() => expect(childGate.entered).toBe(1), { timeout: 5000 });
    const anchor = (await doc(harness, conv)).children.x!.anchor as unknown as TaskId;
    await (await conv.submit({ type: "input", content: "停止" }, context)).wait(context);
    expect(seen.at(-1)!.slice(-3)).toEqual(["子 agent x 已停止", "没有存活的子 agent x", expect.stringContaining("x（已停止）")]);
    expect((await harness.getTask(anchor, context))!.state).toMatchObject({ status: "terminal", outcome: { status: "aborted" } });
    expect((await doc(harness, conv)).children.x).toMatchObject({ stopped: true, pending: [] });
    childGate.open();
    // 停止释放名额，同名可以重新派出。
    await (await conv.submit({ type: "input", content: "再派" }, context)).wait(context);
    await vi.waitFor(async () => expect(await assistantTexts(conv)).toContain("收到：[子 agent 完成] x：新结果"), { timeout: 5000 });
    expect((await reports(conv)).map(e => (e.data as { status: string }).status)).toEqual(["done"]);
  });

  it("message：follow-up 追加任务；steer 并入进行中的工作，共享回答只汇报一次", async () => {
    const childGate = gate();
    const parent = parentBrain({
      开始: [["subagent", { action: "spawn", name: "m", task: "第一件" }]],
      追加: [["subagent", { action: "message", name: "m", task: "第二件" }]],
      再加: [["subagent", { action: "message", name: "m", task: "第三件" }]],
      转向: [["subagent", { action: "message", name: "m", task: "改查北京", mode: "steer" }]],
    });
    const childInputs: string[][] = [];
    const brain = { current: (async (ctx: TranscriptContext, signal: AbortSignal | undefined) => {
      if (!isChild(ctx)) return parent(ctx);
      const users = ctx.messages.filter(m => m.role === "user").map(m => text(m));
      childInputs.push(users);
      // 第三件先停在工具回合里，转向到达后在这一轮工具之后并入。
      if (users.at(-1) === "第三件" && last(ctx).role === "user") { await childGate.wait(signal); return call(["echo", {}]); }
      if (users.includes("第三件")) return fauxAssistantMessage(`合并：${users.slice(users.indexOf("第三件")).join("+")}`);
      return fauxAssistantMessage(`答：${users.at(-1)}`);
    }) as Brain };
    const { harness, model } = await rig(brain);
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
    const idle = () => vi.waitFor(async () => expect((await harness.inspect(context)).submissions).toHaveLength(0), { timeout: 5000 });
    await (await conv.submit({ type: "input", content: "开始" }, context)).wait(context);
    await vi.waitFor(async () => expect(await reports(conv)).toHaveLength(1), { timeout: 5000 });
    await idle();
    await (await conv.submit({ type: "input", content: "追加" }, context)).wait(context);
    await vi.waitFor(async () => expect(await assistantTexts(conv)).toContain("收到：[子 agent 完成] m：答：第二件"), { timeout: 5000 });
    await idle();
    // 子会话忙时 steer：插入到当前工作中，与原消息共享一个回答，只汇报一次。
    const sub = await child(harness, conv, "m");
    await (await conv.submit({ type: "input", content: "再加" }, context)).wait(context);
    await vi.waitFor(() => expect(childGate.entered).toBe(1), { timeout: 5000 });
    await (await conv.submit({ type: "input", content: "转向" }, context)).wait(context);
    childGate.open();
    await vi.waitFor(async () => expect((await doc(harness, conv)).children.m!.pending).toEqual([]), { timeout: 5000 });
    await idle();
    // 两条消息被同一个回答回复，按回答条目去重后只汇报一次。
    expect((await reports(conv)).map(e => text(e.model?.[0]))).toEqual(["[子 agent 完成] m：答：第一件", "[子 agent 完成] m：答：第二件",
      "[子 agent 完成] m：合并：第三件+改查北京"]);
    expect((await entries(sub)).filter(e => e.kind === "pi.assistant")).toHaveLength(4);
  });

  it("限额：同时存活与每日派出数", async () => {
    const seen: string[][] = [];
    const spawn = (n: number) => Array.from({ length: n }, (_, i) => ["subagent", { action: "spawn", task: `任务${i}` }] as [string, JsonObject]);
    const parent = parentBrain({ 四个: spawn(4), 两个: spawn(2), 停两个: [["subagent", { action: "stop", name: "sub-1" }], ["subagent", { action: "stop", name: "sub-2" }]] }, seen);
    const childGate = gate();
    const brain = { current: (async (ctx: TranscriptContext, signal: AbortSignal | undefined) => {
      if (isChild(ctx)) { await childGate.wait(signal); return fauxAssistantMessage("x"); }
      return parent(ctx);
    }) as Brain };
    let now = Date.parse("2026-10-21T10:00:00+08:00");
    const { harness, model } = await rig(brain, { subagent: { maxPerDay: 4, now: () => now } });
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
    const spawned = (name: string) => `已派出子 agent ${name}，完成后结果会自动交回\n该子 agent 没有 MCP 工具（当前未获委派），需要 MCP 的步骤请自己调用。`;
    const concurrent = "子 agent 已达同时存活上限（3 个），请先 stop 不再需要的子 agent";
    await (await conv.submit({ type: "input", content: "四个" }, context)).wait(context);
    expect(seen.at(-1)!.slice(-4)).toEqual([spawned("sub-1"), spawned("sub-2"), spawned("sub-3"), concurrent]);
    // stop 释放同时存活名额，但不退回当天的派出次数。
    await (await conv.submit({ type: "input", content: "停两个" }, context)).wait(context);
    await (await conv.submit({ type: "input", content: "两个" }, context)).wait(context);
    expect(seen.at(-1)!.slice(-2)).toEqual([spawned("sub-4"), "今天派出的子 agent 已达上限（4 个）"]);
    // 跨过上海时间零点后重新计数，同时存活上限仍然生效。
    now = Date.parse("2026-10-22T00:00:01+08:00");
    await (await conv.submit({ type: "input", content: "四个" }, context)).wait(context);
    expect(seen.at(-1)!.slice(-4)).toEqual([spawned("sub-5"), concurrent, concurrent, concurrent]);
    expect(await doc(harness, conv)).toMatchObject({ day: "2026-10-22", spawnedToday: 1 });
    childGate.open();
  });
});

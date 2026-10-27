import { Type, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { GenerationTask, hook, configure, defineDoc, defineExtension, defineTask, defineTool, type ConversationId, type Harness, type ModelRef, type TaskId, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import { isScheduleTool } from "../../shared/schedule-tools.js";
import type { PiMcp } from "../pi-mcp/index.js";
import { McpDelegationDoc, narrowDelegation } from "../pi-mcp/delegation.js";
import { isMcpToolName } from "../pi-mcp/names.js";
import { mergePersons, validPerson, type RunPerson } from "../host/identity.js";

/**
 * 子 agent 扩展（docs/ARCHITECTURE.md §4.3），仿 pi-durable 示例 23-subagent-background：
 * 每个子会话由父会话里的后台锚定任务持有，父会话的中止与空闲等待都碰不到它；
 * 每条交给子会话的消息由一个汇报任务投递，子会话回答后把结果作为 follow-up 输入投回父会话，从而唤醒主 agent。
 * 投递与汇报都带 requestId，重启后重跑只会找回同一提交，不会重复派发或重复汇报。
 * 身份（§5.1）：派出时快照派出那一轮的身份（登记在子 agent 记录里），随每条汇报的条目数据带回；
 * 宿主据此让汇报唤醒的回合继承派出者。之后由别的回合 message 给它时，快照与该回合的身份合并（不同人 → 基础权限）。
 */

/** 汇报输入在父会话中的条目类型；宿主据此（或 requestId 前缀）识别唤醒回合。 */
export const SUBAGENT_REPORT_KIND = "cs.subagent.report";
/** 汇报输入的 requestId 前缀：`subagent-report:<子会话>:<回答条目或提交>`。 */
export const SUBAGENT_REPORT_REQUEST_PREFIX = "subagent-report:";
export const isSubagentReportRequest = (requestId: string | undefined) => !!requestId?.startsWith(SUBAGENT_REPORT_REQUEST_PREFIX);
/**
 * 派出（或 message）子 agent 那一轮的身份快照：turn 为那一轮的类型；as 为它确证绑定的人
 * （唤醒回合为它继承的人；缺省 = 那一轮只有会话基础权限，或多个不同的人交代过任务）。
 */
export type SubagentSpawner = { turn: "user" | "scheduled" | "wake"; as?: RunPerson };
export type SubagentReportData = { name: string; status: "done" | "failed"; child: number; anchor: number; reporter: number; spawner?: SubagentSpawner };

/** 汇报条目数据里确证的派出者；没有记录、形状不对都返回 undefined（基础权限）。 */
export function reportPerson(data: unknown): RunPerson | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const spawner = (data as { spawner?: unknown }).spawner;
  if (!spawner || typeof spawner !== "object" || Array.isArray(spawner)) return undefined;
  const as = (spawner as { as?: unknown }).as;
  return validPerson(as) ? { kind: as.kind, person: as.person, owner: as.owner } : undefined;
}

/** 子 agent 已登记的身份与新交代任务的回合身份合并：不是同一人就降为基础权限（只降不升）。 */
function narrowSpawner(current: SubagentSpawner | undefined, requester: SubagentSpawner | undefined): SubagentSpawner | undefined {
  if (!requester) return current && { turn: current.turn };
  const as = mergePersons([current?.as, requester.as]);
  return { turn: requester.turn, ...(as ? { as } : {}) };
}

/** 子会话不可用的工具：不能再派子 agent、不能授权或定时，也不能对外发消息（只有主 agent 对用户说话），记忆只读。 */
export const SUBAGENT_EXCLUDED_TOOLS = { exact: ["subagent", "send_message", "skill_publish", "mem_remember", "mem_update", "mem_forget", "mem_profile"],
  prefixes: ["auth_", "schedule_"] } as const;
export function isSubagentExcludedTool(name: string, allowMcp?: (name: string) => boolean): boolean {
  return (SUBAGENT_EXCLUDED_TOOLS.exact as readonly string[]).includes(name) ||
    SUBAGENT_EXCLUDED_TOOLS.prefixes.some(prefix => name.startsWith(prefix)) || isScheduleTool(name) ||
    (isMcpToolName(name) && !allowMcp?.(name));
}

export const DEFAULT_SUBAGENT_INSTRUCTIONS = "你是主 agent 派出的子 agent，只负责完成交给你的任务。你不能直接联系用户；把最终结果写在回答里，它会原样交回主 agent。";

export interface SubagentOptions {
  getHarness: () => Harness;
  mcp?: () => PiMcp | undefined;
  /** 未设置时沿用父会话的模型与思考等级。 */
  model?: ModelRef;
  thinkingLevel?: ModelThinkingLevel;
  /** 子会话的 agent instructions；null 表示沿用父会话的。 */
  instructions?: string | null;
  /** 每个父会话同时存活（未 stop）的子 agent 上限。 */
  maxConcurrent?: number;
  /** 每个父会话每天（Asia/Shanghai）最多派出的子 agent 数。 */
  maxPerDay?: number;
  now?: () => number;
  /** 在创建子会话的同一提交中运行，供宿主写入子会话需要的文档（如身份绑定）。 */
  initChild?: (tx: Tx, parent: ConversationId, child: ConversationId) => void | Promise<void>;
  /** 派出 / message 时调用：求出父会话当前这一轮的身份快照（§5.1）；未提供或返回 undefined 时汇报唤醒只有基础权限。 */
  spawner?: (parent: ConversationId) => Promise<SubagentSpawner | undefined>;
}

type ChildRecord = {
  name: string;
  anchor: number;
  conversation: number;
  task: string;
  createdAt: number;
  stopped: boolean;
  /** 尚未结束的汇报任务。 */
  pending: number[];
  /** 派出者身份快照（之后 message 它的回合与之合并）；缺省 = 基础权限 */
  spawner?: SubagentSpawner;
  last?: { status: "done" | "failed"; text: string; at: number };
};

/** 父会话上的子 agent 登记；按名字索引，calls 让重放的工具调用拿回第一次的结果。 */
export const SubagentDoc = defineDoc<{
  children: Record<string, ChildRecord>;
  seq: number;
  day: string;
  spawnedToday: number;
  calls: Record<string, string>;
}>({
  kind: "cs.subagent.children", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ children: {}, seq: 0, day: "", spawnedToday: 0, calls: {} }),
});

const MAX_CALL_MEMO = 64;
const MAX_REPORT_CHARS = 8000;
const taskId = (id: number) => id as unknown as TaskId;
const conversationId = (id: number) => id as unknown as ConversationId;
const shanghaiDay = (now: number) => new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
const clip = (text: string, max: number) => text.length > max ? text.slice(0, max) + `…（截断，共 ${text.length} 字）` : text;
const output = (text: string, isError = false) => ({ output: [{ type: "text" as const, text }], ...(isError ? { isError } : {}) });

function findByAnchor(children: Record<string, ChildRecord>, anchor: number) {
  return Object.values(children).find(child => child.anchor === anchor);
}

/** 锚定任务只负责持有子会话与汇报任务；stop 即中止它，中止先级联到子会话和汇报任务。 */
const Anchor = defineTask<{ name: string }, { phase: "hold" }, null>({
  name: "cs.subagent.anchor", version: 1,
  initial: () => ({ phase: "hold" }),
  phases: {
    // 不提交进度地长期等待；重启后重新进入同一阶段，直到被中止。
    hold: async (_task, runtime, context) => { await runtime.sleep(Number.POSITIVE_INFINITY, context); },
  },
  abort: async (task, runtime, context) => {
    await runtime.commit(async tx => {
      const child = findByAnchor((await tx.doc(SubagentDoc, task.conversationId)).children, Number(task.id));
      if (child) { child.stopped = true; child.pending = []; }
      return { status: "terminal", outcome: { status: "aborted", reason: "stopped" } };
    }, context);
  },
});

/** spawner：交代这条消息时子 agent 登记的身份快照（创建任务时固定，重放不变），随汇报带回。 */
type ReporterInput = { name: string; anchor: number; child: number; content: string; whenBusy: "steer" | "followUp"; spawner?: SubagentSpawner };
type ReporterState = { phase: "deliver" } | { phase: "report"; status: "done" | "failed"; text: string; key: string };

/** 汇报任务：把一条消息交给子会话、等它回答，再把结果作为 follow-up 输入投回父会话。 */
const createReporter = (opts: SubagentOptions) => defineTask<ReporterInput, ReporterState, { status: "done" | "failed" }>({
  name: "cs.subagent.reporter", version: 1,
  initial: () => ({ phase: "deliver" }),
  phases: {
    deliver: async (task, runtime, context) => {
      const child = await runtime.conversation(conversationId(task.input.child), context);
      if (!child) throw new Error("子会话不存在");
      await opts.mcp?.()?.configureChild(child, context);
      // requestId 绑定本任务：重启后重跑拿回同一提交，不会把消息再交一次。
      const submission = await child.submit({ type: "input", content: task.input.content,
        requestId: `subagent:${task.id}`, whenBusy: task.input.whenBusy }, context);
      const settled = await submission.wait(context);
      await runtime.commit(async tx => {
        if (settled.type !== "input" || settled.status !== "done") {
          const reason = settled.status === "unanswered" ? settled.reason + (settled.detail === undefined ? "" : `：${JSON.stringify(settled.detail)}`) : settled.status;
          return { status: "running", checkpoint: { phase: "report", status: "failed", text: reason, key: `s${settled.id}` } };
        }
        const entry = await tx.entry(settled.answer);
        const text = (entry?.model ?? []).flatMap(m => m.role === "assistant" ? m.content.filter(c => c.type === "text").map(c => c.text) : [])
          .join("").trim();
        // 转向（steer）会并入子会话当前这次运行，与原消息共享同一个回答；按回答条目去重，只汇报一次。
        return { status: "running", checkpoint: { phase: "report", status: "done", text: text || "（没有文字回答）", key: `e${settled.answer}` } };
      }, context);
    },
    report: async (task, runtime, context) => {
      const { status, text, key } = task.state.checkpoint;
      const { name, anchor, child } = task.input;
      const parent = await runtime.conversation(task.conversationId, context);
      if (!parent) throw new Error("父会话不存在");
      // 汇报时再与登记的当前身份合并（只降不升）：创建后有别人 message（转向会并入同一回答）时，旧汇报任务的快照不能单独带回。
      const record = findByAnchor((await runtime.snapshot(SubagentDoc, task.conversationId, context))?.children ?? {}, anchor);
      const spawner = task.input.spawner && record?.spawner ? narrowSpawner(record.spawner, task.input.spawner) : undefined;
      const data: SubagentReportData = { name, status, child, anchor, reporter: Number(task.id),
        ...(spawner ? { spawner } : {}) };
      await parent.submit({ type: "input", whenBusy: "followUp",
        requestId: `${SUBAGENT_REPORT_REQUEST_PREFIX}${child}:${key}`,
        content: `${status === "done" ? "[子 agent 完成]" : "[子 agent 失败]"} ${name}：${clip(text, MAX_REPORT_CHARS)}`,
        entry: { kind: SUBAGENT_REPORT_KIND, data } }, context);
      await runtime.commit(async tx => {
        const record = findByAnchor((await tx.doc(SubagentDoc, task.conversationId)).children, anchor);
        if (record) {
          record.pending = record.pending.filter(id => id !== Number(task.id));
          record.last = { status, text: clip(text, MAX_REPORT_CHARS), at: runtime.now() };
        }
        return { status: "terminal", outcome: { status: "completed", result: { status } } };
      }, context);
    },
  },
  abort: async (task, runtime, context) => {
    await runtime.commit(async tx => {
      const record = findByAnchor((await tx.doc(SubagentDoc, task.conversationId)).children, task.input.anchor);
      if (record) record.pending = record.pending.filter(id => id !== Number(task.id));
      return { status: "terminal", outcome: { status: "aborted", reason: "stopped" } };
    }, context);
  },
});

const Parameters = Type.Object({
  action: Type.Union([Type.Literal("spawn"), Type.Literal("message"), Type.Literal("status"), Type.Literal("list"), Type.Literal("stop")], {
    description: "spawn starts a new subagent; message sends a message to an existing subagent; status/list inspects subagents; stop stops one and frees its slot",
  }),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 32, description: "Subagent name; optional for spawn" })),
  task: Type.Optional(Type.String({ minLength: 1, maxLength: 20000, description: "Task instructions for spawn, or message content for message" })),
  mode: Type.Optional(Type.Union([Type.Literal("followUp"), Type.Literal("steer")], {
    description: "Delivery mode for message: followUp (default) waits until its current work finishes; steer inserts the message into its ongoing work",
  })),
}, { additionalProperties: false });

const NAME = /^[\p{L}\p{N}_-]{1,32}$/u;
const noMcpHint = (reason: string) => `\n该子 agent 没有 MCP 工具（${reason}），需要 MCP 的步骤请自己调用。`;

function describe(child: ChildRecord, full = false): string {
  const state = child.stopped ? "已停止" : child.pending.length ? "工作中" : "空闲";
  const last = child.last ? `，最近${child.last.status === "done" ? "结果" : "失败"}：${clip(child.last.text, full ? 4000 : 200)}` : "";
  return `${child.name}（${state}）任务：${clip(child.task, full ? 1000 : 80)}${last}`;
}

/** 子 agent 扩展；仅导出工厂，由宿主决定安装与选择。 */
export function createSubagentExtension(opts: SubagentOptions) {
  const Reporter = createReporter(opts);
  const maxConcurrent = opts.maxConcurrent ?? 3, maxPerDay = opts.maxPerDay ?? 20;
  const now = opts.now ?? Date.now;
  const instructions = opts.instructions === undefined ? DEFAULT_SUBAGENT_INSTRUCTIONS : opts.instructions;

  /** 同一工具调用重放时返回第一次的结果；记录有上限，只为覆盖崩溃重跑的窗口。 */
  const remember = (calls: Record<string, string>, key: string, text: string) => {
    const keys = Object.keys(calls);
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_CALL_MEMO + 1))) delete calls[old];
    calls[key] = text;
    return text;
  };

  const tool = defineTool({
    name: "subagent",
    description: "Delegate independent, time-consuming tasks to a background subagent. spawn returns immediately; when the subagent finishes, its result is automatically returned to you as '[子 agent 完成]' input. Subagents cannot contact users, grant permissions, or schedule tasks.",
    parameters: Parameters,
    replay: "safe",
    async execute(args, api, context) {
      const call = String(api.taskId);
      if (args.action === "status" || args.action === "list") {
        const doc = await api.snapshot(SubagentDoc, api.conversationId, context);
        const children = Object.values(doc?.children ?? {});
        if (args.action === "status" && args.name) {
          const child = doc?.children[args.name];
          return child ? output(describe(child, true)) : output(`没有名为 ${args.name} 的子 agent`, true);
        }
        return output(children.length ? children.map(child => describe(child)).join("\n") : "当前没有子 agent");
      }
      if (args.action === "spawn") {
        if (!args.task) return output("spawn 需要 task", true);
        if (args.name !== undefined && !NAME.test(args.name)) return output("名字只能包含文字、数字、_ 与 -，最长 32 个字符", true);
        const parentAgent = await api.agent(context);
        // 派出那一轮的身份快照（§5.1）：汇报唤醒的回合继承它。
        const spawner = await opts.spawner?.(api.conversationId);
        const mcp = opts.mcp?.(), grant = await mcp?.delegation(api.conversationId) ?? null;
        const hint = !grant && [...parentAgent.tools, ...parentAgent.callable].some(tool => isMcpToolName(tool.name))
          ? noMcpHint("当前未获委派") : "";
        // 子会话的工具集：父会话启用的工具减去排除名单，显式写成数组，宿主后续换扩展也不会带回被排除的工具。
        const seen = new Set<string>(), tools: ToolRegistration[] = [];
        for (const tool of [...parentAgent.tools, ...parentAgent.callable]) {
          if (seen.has(tool.name) || isSubagentExcludedTool(tool.name, name => mcp?.allowsDelegationTool(grant, name) ?? false)) continue;
          seen.add(tool.name); tools.push(tool);
        }
        const result = await api.commit(async tx => {
          const doc = await tx.doc(SubagentDoc, api.conversationId);
          if (doc.calls[call]) return { text: doc.calls[call], error: false };
          const day = shanghaiDay(now());
          if (doc.day !== day) { doc.day = day; doc.spawnedToday = 0; }
          const live = Object.values(doc.children).filter(child => !child.stopped);
          if (live.length >= maxConcurrent) return { text: `子 agent 已达同时存活上限（${maxConcurrent} 个），请先 stop 不再需要的子 agent`, error: true };
          if (doc.spawnedToday >= maxPerDay) return { text: `今天派出的子 agent 已达上限（${maxPerDay} 个）`, error: true };
          const name = args.name ?? `sub-${doc.seq + 1}`;
          if (doc.children[name] && !doc.children[name].stopped) return { text: `已有名为 ${name} 的子 agent，请换个名字或用 message`, error: true };
          const anchor = await tx.createTask(Anchor, { name }, { ownership: { kind: "conversation" }, background: true, conversationId: api.conversationId });
          // 子会话归锚定任务所有；创建时复制父会话的 agent，再覆盖模型、工具与说明。
          const created = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
          await configure(tx, created.id, {
            tools,
            ...(opts.model ? { model: opts.model } : {}),
            ...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
            ...(instructions !== null ? { instructions } : {}),
          });
          await opts.initChild?.(tx, api.conversationId, created.id);
          (await tx.doc(McpDelegationDoc, created.id)).grant = grant;
          const reporter = await tx.createTask(Reporter, { name, anchor: Number(anchor), child: Number(created.id), content: args.task!, whenBusy: "followUp",
            ...(spawner ? { spawner } : {}) } satisfies ReporterInput, { ownership: { kind: "task", taskId: anchor } });
          doc.seq++; doc.spawnedToday++;
          doc.children[name] = { name, anchor: Number(anchor), conversation: Number(created.id), task: args.task!, createdAt: now(), stopped: false, pending: [Number(reporter)],
            ...(spawner ? { spawner } : {}) };
          return { text: remember(doc.calls, call, `已派出子 agent ${name}，完成后结果会自动交回${hint}`), error: false, child: Number(created.id) };
        }, context);
        if ("child" in result && result.child !== undefined) await api.details({ conversationId: result.child }, context);
        return output(result.text, result.error);
      }
      if (!args.name) return output(`${args.action} 需要 name`, true);
      const name = args.name;
      if (args.action === "message") {
        if (!args.task) return output("message 需要 task（消息内容）", true);
        const requester = await opts.spawner?.(api.conversationId);
        const grant = await opts.mcp?.()?.delegation(api.conversationId) ?? null;
        const parentAgent = await api.agent(context);
        const parentHasMcp = [...parentAgent.tools, ...parentAgent.callable].some(tool => isMcpToolName(tool.name));
        const result = await api.commit(async tx => {
          const doc = await tx.doc(SubagentDoc, api.conversationId);
          if (doc.calls[call]) return { text: doc.calls[call], error: false };
          const child = doc.children[name];
          if (!child || child.stopped) return { text: `没有存活的子 agent ${name}`, error: true };
          const delegation = await tx.doc(McpDelegationDoc, conversationId(child.conversation));
          const previous = delegation.grant;
          delegation.grant = narrowDelegation(previous, grant);
          const hint = previous && !delegation.grant && parentHasMcp
            ? noMcpHint(requester?.as && requester.as.person !== previous.principal ? "交代人与派出人不同" : "本次交代不满足委派条件") : "";
          const mode: ReporterInput["whenBusy"] = args.mode ?? "followUp";
          // 子 agent 的上下文里已有这一轮交代的内容：登记的身份与之合并（不同人 → 基础权限），此后的汇报都带合并后的身份。
          const spawner = narrowSpawner(child.spawner, requester);
          if (spawner) child.spawner = spawner; else delete child.spawner;
          const reporter = await tx.createTask(Reporter, { name, anchor: child.anchor, child: child.conversation, content: args.task!, whenBusy: mode,
            ...(spawner ? { spawner } : {}) } satisfies ReporterInput, { ownership: { kind: "task", taskId: taskId(child.anchor) } });
          child.pending.push(Number(reporter));
          return { text: remember(doc.calls, call, `已${mode === "steer" ? "转向" : "追加消息给"}子 agent ${name}，结果会自动交回${hint}`), error: false };
        }, context);
        return output(result.text, result.error);
      }
      // stop：中止锚定任务，级联中止子会话的工作与未完成的汇报；锚定任务的中止处理把登记标为已停止。
      const doc = await api.snapshot(SubagentDoc, api.conversationId, context);
      const child = doc?.children[name];
      if (!child) return output(`没有名为 ${name} 的子 agent`, true);
      if (!child.stopped) {
        const harness = opts.getHarness();
        await harness.abortTask(taskId(child.anchor), context);
        await harness.waitForTask(taskId(child.anchor), context);
      }
      return output(`子 agent ${name} 已停止`);
    },
  });

  return defineExtension({ name: "cs-pi-subagent", tools: [tool], tasks: [Anchor, Reporter],
    hooks: [hook(GenerationTask, { beforeRequest: (request, api, context) =>
      opts.mcp?.()?.childRequest(request.messages, api.conversationId, context) })] });
}

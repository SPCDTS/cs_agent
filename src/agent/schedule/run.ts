import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { defineDoc, defineDocFamily, defineTask, type ConversationId, type Harness, type Tx } from "@earendil-works/pi-durable";
import type { Channel, OutboundTicket } from "../../channel/types.js";
import { isScope } from "../../context/access.js";
import { trace } from "../../shared/trace.js";
import { DispatchDoc, TicketDoc } from "../docs.js";
import type { TicketSource } from "../backends/types.js";
import type { CsTasks, TaskInput, TaskResult } from "../tasks.js";
import type { ScheduleConversation, ScheduledFire, ScheduledRunAdmitter, ScheduleRun, ScheduleRunRecorder } from "./types.js";

type RunState = {
  schedule_id: string;
  fire_key: string;
  fire_at: number;
  ordinal: number;
  conversation: ScheduleConversation;
  created_by: string;
  timeout_ms: number;
  started_at?: number;
  denied?: boolean;
  /** 回写前保存最终结果；回写与票据结算跨库，恢复必须重放同一结果。 */
  result?: { [K in keyof ScheduleRun]: ScheduleRun[K] };
  recorded?: boolean;
  paused?: boolean;
};

export const ScheduledRunDoc = defineDoc<RunState>({
  kind: "cs.scheduled-run", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ schedule_id: "", fire_key: "", fire_at: 0, ordinal: 0,
    conversation: "owner", created_by: "", timeout_ms: 300_000 }),
});

/** DispatchDoc 清除后仍保留幂等凭据；每次触发一份文档，避免重写不断增长的全局表。 */
const AdmissionDoc = defineDocFamily<{ conversationId?: number }, Record<string, never>>({
  kind: "cs.scheduled-admission", version: 1, scope: "session", family: true, initial: () => ({}),
});

export function scheduledTicket(fireKey: string): string {
  return "run_" + createHash("sha256").update(fireKey).digest("hex").slice(0, 40);
}

function beijingTime(ms: number): string {
  return new Date(ms + 8 * 60 * 60_000).toISOString().slice(5, 16).replace("T", " ");
}

export function scheduledInput(fire: ScheduledFire): string {
  const recent = fire.schedule.runs.filter(run => run.fire_key !== fire.fire_key).slice(-3)
    .map(run => `${beijingTime(run.fire_at)} ${run.status}${run.note ? " " + run.note.replace(/\s+/g, " ").slice(0, 200) : ""}`);
  return `[定时任务] ${fire.schedule.name} · 计划时间 ${beijingTime(fire.fire_at)}（北京时间）· 第 ${fire.ordinal} 次\n` +
    `${fire.schedule.prompt}\n[最近运行] ${recent.join("；") || "无"}\n` +
    "[说明] 这是定时任务，不是用户消息。需要通知就调用 send_message（可带 target），不需要就直接结束。";
}

export interface ScheduledRuntimeOptions {
  getChannel(): Pick<Channel, "openOutbound" | "getTicket">;
  tasks: CsTasks;
  recorder: ScheduleRunRecorder;
  /** 主进程身份配置，可在运行前读取当前 owner。 */
  owner?: string | (() => string | undefined);
  /** actor 为 qq:<创建者>；缺省只允许当前 owner。每次调用后端前重新检查。 */
  canSchedule?(actor: string, conversation: ScheduleConversation): boolean | Promise<boolean>;
  /** 由定义服务提供幂等暂停；B 不依赖或修改 SchedulesDoc。 */
  pauseSchedule(scheduleId: string, reason: string): Promise<void>;
}

type RunStore = {
  snapshot: Harness["snapshot"];
  commit(fn: (tx: Tx) => Promise<void>, context: Context): Promise<unknown>;
};

export function createScheduledRuntime(opts: ScheduledRuntimeOptions) {
  const owner = () => typeof opts.owner === "function" ? opts.owner() : opts.owner;
  const { tasks } = opts;

  function binding(fire: ScheduledFire): { scope: string; source: TicketSource; outbound: OutboundTicket } {
    const user = /^qq:([1-9][0-9]{0,19})$/.exec(fire.schedule.created_by)?.[1];
    const conversation = fire.schedule.conversation;
    const scope = conversation === "owner" ? `private:${owner() ?? ""}` : conversation;
    if (!user || !isScope(scope) || fire.fire_key !== `${fire.schedule.id}@${fire.fire_at}` ||
        !Number.isSafeInteger(fire.fire_at) || !Number.isSafeInteger(fire.ordinal) || fire.ordinal < 1 ||
        !Number.isFinite(fire.schedule.options.timeout_ms) || fire.schedule.options.timeout_ms <= 0 ||
        fire.schedule.options.timeout_ms > 900_000) throw new Error("定时触发绑定无效");
    const group = scope.startsWith("group:");
    const target_id = scope.slice(scope.indexOf(":") + 1);
    return { scope, source: { type: group ? "group" : "private", user_id: user,
      group_id: group ? target_id : null, nickname: user },
    outbound: { message_type: group ? "group" : "private", target_id, origin: "scheduled", user_id: user } };
  }

  /**
   * 必须在排程事务之前调用。返回的 admitter 只使用传入 tx，不做网络或嵌套提交。
   * 本次输入在预备时冻结，同一 fire_key 的重试不受 runs 等后续变更影响。
   * 同一份预备结果可在事务回滚后重试；提交成功后调用 dispatcher.dispatchScheduled(ticket)。
   */
  async function prepare(input: ScheduledFire): Promise<ScheduledRunAdmitter> {
    const fire = structuredClone(input), ticket = scheduledTicket(fire.fire_key);
    const { scope, source, outbound } = binding(fire);
    const rec = await opts.getChannel().openOutbound(ticket, outbound);
    const text = scheduledInput(fire);
    const settings = await tasks.snapshotSettings(scope, undefined, { ticket, text, hasImages: false, hasQuote: false });
    return {
      async admit(transaction, candidate) {
        if (candidate.fire_key !== fire.fire_key) throw new Error("预备票据与触发标识不一致");
        const tx = transaction as Tx;
        const known = await tx.doc(AdmissionDoc, ticket, {});
        // 终态孤儿票据也不得重新派发。
        if (known.conversationId !== undefined) return { ticket };
        if (rec.status !== "pending") return { ticket, skipped: true };
        const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
        Object.assign(await tx.doc(TicketDoc, conversation.id), {
          ticket, source, text, route: "agent", settings, time: Math.floor(fire.fire_at / 1000),
        });
        Object.assign(await tx.doc(ScheduledRunDoc, conversation.id), {
          schedule_id: fire.schedule.id, fire_key: fire.fire_key, fire_at: fire.fire_at,
          ordinal: fire.ordinal, conversation: fire.schedule.conversation, created_by: fire.schedule.created_by,
          timeout_ms: fire.schedule.options.timeout_ms,
        });
        (await tx.doc(DispatchDoc)).pending[ticket] = {
          kind: "scheduled", conversationId: conversation.id, scope, ticketSeq: rec.seq, attempts: 0,
        };
        known.conversationId = conversation.id;
        return { ticket };
      },
    };
  }

  /** 任务与派发器故障恢复共用；recordRun 按 fire_key 幂等覆盖，暂停回调也必须幂等。 */
  async function finish(store: RunStore, id: ConversationId, context: Context,
    now = Date.now(), forceFailure = false): Promise<void> {
    const ticketDoc = await store.snapshot(TicketDoc, id, context);
    let run = await store.snapshot(ScheduledRunDoc, id, context);
    if (!ticketDoc?.ticket || !run?.fire_key) throw new Error("定时运行文档缺失");
    const ticket = ticketDoc.ticket;
    if (ticketDoc.replyCompleted) return;
    await tasks.sendService.reconcile(ticket);
    if (!run.result) {
      const rows = tasks.sendService.rows(ticket);
      const sent = rows.filter(row => row.status === "sent").length;
      const result = ticketDoc.agentResult;
      // 不确定的投递不能算静默或成功；保留 Outbox 状态且永不重发。
      const deliveryFailed = rows.some(row => row.status !== "sent" || row.files.some(file => file.status !== "sent"));
      const failed = run.denied || forceFailure || !result?.ok || deliveryFailed;
      const record: ScheduleRun = {
        fire_key: run.fire_key, fire_at: run.fire_at, ticket, status: failed ? "failed" : sent ? "sent" : "silent",
        sent, ...(run.started_at !== undefined ? { started_at: run.started_at } : {}), ended_at: now,
        ...(failed && !run.denied ? { reason: result && !result.ok && result.failure === "timeout" ? "timeout" : "backend_failed" } : {}),
        note: run.denied ? "无权：创建者已无定时任务权限" : result?.ok ? [...result.text].slice(0, 200).join("") : "",
      };
      await store.commit(async tx => { (await tx.doc(ScheduledRunDoc, id)).result = record; }, context);
      run = (await store.snapshot(ScheduledRunDoc, id, context))!;
    }
    if (run.denied && !run.paused) {
      await opts.pauseSchedule(run.schedule_id, "无权：创建者已无定时任务权限");
      await store.commit(async tx => { (await tx.doc(ScheduledRunDoc, id)).paused = true; }, context);
    }
    if (!run.recorded) {
      await opts.recorder.recordRun(run.schedule_id, run.result!);
      await store.commit(async tx => { (await tx.doc(ScheduledRunDoc, id)).recorded = true; }, context);
    }
    // silent / failed 也置票据终态，允许同 scope 后续消息继续。
    await tasks.sendService.settle(ticket);
    await store.commit(async tx => { (await tx.doc(TicketDoc, id)).replyCompleted = true; }, context);
    trace.event(ticket, "schedule_run", { status: run.result!.status, detail: {
      fire_key: run.fire_key, ordinal: run.ordinal, status: run.result!.status, sent: run.result!.sent, terminal: true,
    } });
    trace.event(ticket, "final_answer", { detail: {
      text: ticketDoc.agentResult?.ok ? ticketDoc.agentResult.text : "", sent_messages: run.result!.sent,
    } });
  }

  const ScheduledTask = defineTask<TaskInput, { phase: "handle" } | { phase: "settle"; attempt: number }, TaskResult>({
    name: "cs.scheduled", version: 1, initial: () => ({ phase: "handle" }),
    phases: {
      handle: async (_task, runtime, context) => {
        const doc = await runtime.snapshot(TicketDoc, runtime.conversationId, context);
        let run = await runtime.snapshot(ScheduledRunDoc, runtime.conversationId, context);
        if (!doc?.ticket || !run?.fire_key) throw new Error("定时运行文档缺失");
        if (doc.agentResult || run.result || run.denied) {
          await runtime.commit(async () => ({ status: "running", checkpoint: { phase: "settle", attempt: 0 } }), context);
          return;
        }
        const currentOwner = owner(), senderIsOwner = run.created_by === `qq:${currentOwner}`;
        const allowed = (run.conversation !== "owner" || senderIsOwner) &&
          (opts.canSchedule ? await opts.canSchedule(run.created_by, run.conversation) : senderIsOwner);
        runtime.signal.throwIfAborted();
        await runtime.commit(async tx => {
          const state = await tx.doc(ScheduledRunDoc, runtime.conversationId);
          state.started_at ??= runtime.now();
          if (!allowed) state.denied = true;
          return undefined;
        }, context);
        run = (await runtime.snapshot(ScheduledRunDoc, runtime.conversationId, context))!;
        if (!allowed) {
          await runtime.commit(async () => ({ status: "running", checkpoint: { phase: "settle", attempt: 0 } }), context);
          return;
        }
        const entry = (await runtime.snapshot(DispatchDoc, context))?.pending[doc.ticket];
        if (!entry?.scope) throw new Error("定时派发 scope 缺失");
        await opts.recorder.recordRun(run.schedule_id, {
          fire_key: run.fire_key, fire_at: run.fire_at, status: "running", started_at: run.started_at, ticket: doc.ticket,
        });
        const remaining = run.started_at! + run.timeout_ms - runtime.now();
        const signal = AbortSignal.any([runtime.signal, remaining > 0
          ? AbortSignal.timeout(Math.ceil(remaining)) : AbortSignal.abort(new Error("定时运行超时"))]);
        await tasks.handleAgent(runtime, context, { scheduled: true, signal, request: {
          scope: entry.scope, access: senderIsOwner ? "all" : entry.scope,
          threadKey: run.conversation, senderIsOwner,
        } });
      },
      settle: async (_task, runtime, context) => {
        // 适配 TaskRuntime.commit：只提交文档变更，不在 finish 内推进任务检查点。
        const store: RunStore = {
          snapshot: runtime.snapshot.bind(runtime),
          commit: (fn, ctx) => runtime.commit(async tx => { await fn(tx); return undefined; }, ctx),
        };
        await finish(store, runtime.conversationId, context, runtime.now());
        const run = (await runtime.snapshot(ScheduledRunDoc, runtime.conversationId, context))!;
        await runtime.commit(async () => ({ status: "terminal", outcome: {
          status: "completed", result: { sent: (run.result?.sent ?? 0) > 0 },
        } }), context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(async () => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });
  return { prepare, ScheduledTask, finish };
}

export type ScheduledRuntime = ReturnType<typeof createScheduledRuntime>;

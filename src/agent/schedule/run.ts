import { isOwnerActor } from "../../shared/owners.js";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { createHash } from "node:crypto";
import { defineDoc, defineDocFamily, type ConversationId, type Harness, type Tx } from "@earendil-works/pi-durable";
import type { Channel } from "../../channel/types.js";
import { isScope } from "../../context/access.js";
import { log } from "../../shared/log.js";
import { trace } from "../../shared/trace.js";
import type { TurnStatus } from "../host/types.js";
import { ScheduleRuntimeDoc } from "./docs.js";
import type { ScheduleConversation, ScheduledFire, ScheduledRunAdmitter, ScheduleRun, ScheduleRunRecorder } from "./types.js";

/**
 * 定时运行（设计 §10）：到点向来源会话的 ThreadHost 投一条定时输入（kind=scheduled，发送者 = 创建者），
 * 线程忙则排队等空闲。运行记录 cs.scheduled-run 保留；结果按该输入所在回合发出的消息数统计：
 * 有发送 → sent，无 → silent，回合失败 / 丢失或投递不确定 → failed。
 * 第 2 阶段只统计输入所在的那一个回合，不含其后由子 agent 唤醒的回合。
 */
type RunState = {
  schedule_id: string;
  fire_key: string;
  fire_at: number;
  ordinal: number;
  conversation: ScheduleConversation;
  created_by: string;
  timeout_ms: number;
  /** 定时输入的入站键（run_ 开头），也是 admission 的成员键 */
  input_key?: string;
  started_at?: number;
  /** 输入所在回合（送达后端时写入） */
  turn_id?: string;
  denied?: boolean;
  /** 回写前保存最终结果；回写跨文档，恢复必须重放同一结果。 */
  result?: { [K in keyof ScheduleRun]: ScheduleRun[K] };
  recorded?: boolean;
  paused?: boolean;
};

export const ScheduledRunDoc = defineDoc<RunState>({
  kind: "cs.scheduled-run", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ schedule_id: "", fire_key: "", fire_at: 0, ordinal: 0,
    conversation: "owner", created_by: "", timeout_ms: 300_000 }),
});

/** 每次触发一份幂等凭据（成员键 = 定时输入键），指向保存运行文档的会话。 */
const AdmissionDoc = defineDocFamily<{ conversationId?: number }, Record<string, never>>({
  kind: "cs.scheduled-admission", version: 1, scope: "session", family: true, initial: () => ({}),
});

/** 定时输入的确定性键：run_ + sha256(fire_key) 前 40 位。 */
export function scheduledInputKey(fireKey: string): string {
  return "run_" + createHash("sha256").update(fireKey).digest("hex").slice(0, 40);
}

/** 从已提交 admission 反查本次运行；工具参数不能指定或覆盖目标。 */
export async function readScheduledRun(harness: Pick<Harness, "snapshot">, key: string) {
  if (!/^run_[a-f0-9]{40}$/.test(key)) return undefined;
  const admission = await harness.snapshot(AdmissionDoc, key, BACKGROUND_CONTEXT);
  if (admission?.conversationId === undefined) return undefined;
  const run = await harness.snapshot(ScheduledRunDoc, admission.conversationId as ConversationId, BACKGROUND_CONTEXT);
  return run?.schedule_id && run.fire_key === `${run.schedule_id}@${run.fire_at}` && scheduledInputKey(run.fire_key) === key
    ? { ...run, conversationId: admission.conversationId as ConversationId } : undefined;
}

function beijingTime(ms: number): string {
  return new Date(ms + 8 * 60 * 60_000).toISOString().slice(5, 16).replace("T", " ");
}

export function scheduledInput(fire: ScheduledFire): string {
  const recent = fire.schedule.runs.filter(run => run.fire_key !== fire.fire_key).slice(-3)
    .map(run => `${beijingTime(run.fire_at)} ${run.status}${run.note ? " " + run.note.replace(/\s+/g, " ").slice(0, 200) : ""}`);
  return `[定时任务] ${fire.schedule.name} · 计划时间 ${beijingTime(fire.fire_at)}（北京时间）· 第 ${fire.ordinal} 次 · 创建者 ${fire.schedule.created_by}\n` +
    `${fire.schedule.prompt}\n[最近运行] ${recent.join("；") || "无"}\n` +
    "[说明] 这是定时任务，不是用户消息。需要通知就调用 send_message（可带 target），不需要就直接结束。需要停止后续触发时调用 schedule_control，说明暂停或完成的原因。";
}

export interface ScheduledRuntimeOptions {
  getChannel(): Pick<Channel, "inbox" | "outbox">;
  /** 保存运行文档与 admission 的派发 harness */
  getHarness(): Pick<Harness, "snapshot" | "commit">;
  /** 投递定时输入（Inbox → ThreadHost） */
  deliver(key: string): Promise<void>;
  /** 宿主中的输入状态（恢复时判断输入是否已结束） */
  inputState?(key: string): Promise<"queued" | "delivered" | "done" | undefined>;
  /** 已结束输入所在回合的结果（宿主与 done 同一提交写入）：结算回写前崩溃时据此重放同一结果 */
  inputOutcome?(key: string): Promise<{ status: TurnStatus; turnId?: string } | undefined>;
  recorder: ScheduleRunRecorder;
  /** 主进程身份配置，可在运行前读取当前 owner。 */
  owner?: string | (() => string | undefined);
  owners?: readonly string[] | (() => readonly string[]);
  /** actor 为 qq:<创建者>；缺省只允许当前 owner。投递前重新检查。 */
  canSchedule?(actor: string, conversation: ScheduleConversation): boolean | Promise<boolean>;
  /** 由定义服务提供幂等暂停。 */
  pauseSchedule(scheduleId: string, reason: string): Promise<void>;
  context?: Context;
}

export function createScheduledRuntime(opts: ScheduledRuntimeOptions) {
  const ctx = opts.context ?? BACKGROUND_CONTEXT;
  const owner = () => typeof opts.owner === "function" ? opts.owner() : opts.owner;
  const owners = () => (typeof opts.owners === "function" ? opts.owners() : opts.owners) ?? owner();

  /** 输入地址：群或私聊即会话本身；owner 会话发往当前首个 owner 的私聊。 */
  function binding(fire: ScheduledFire): { scope: string; threadKey: string } {
    const conversation = fire.schedule.conversation;
    const scope = conversation === "owner" ? `private:${owner() ?? ""}` : conversation;
    if (!/^qq:[1-9][0-9]{0,19}$/.test(fire.schedule.created_by) || !isScope(scope) || fire.fire_key !== `${fire.schedule.id}@${fire.fire_at}` ||
        !Number.isSafeInteger(fire.fire_at) || !Number.isSafeInteger(fire.ordinal) || fire.ordinal < 1) throw new Error("定时触发绑定无效");
    return { scope, threadKey: conversation };
  }

  /**
   * 必须在排程事务之前调用：在 Inbox 写入定时输入（幂等，内容在预备时冻结）。
   * admit 只使用传入 tx 登记运行文档；提交成功后调用 launch(key)。
   */
  async function prepare(input: ScheduledFire): Promise<ScheduledRunAdmitter> {
    const fire = structuredClone(input), key = scheduledInputKey(fire.fire_key);
    const { scope, threadKey } = binding(fire);
    opts.getChannel().inbox.openScheduledInput({ key, scope, thread_key: threadKey, creator: fire.schedule.created_by,
      text: scheduledInput(fire), time: Math.floor(fire.fire_at / 1000) });
    return {
      async discard(transaction) {
        const known = await (transaction as Tx).doc(AdmissionDoc, key, {});
        // 未被采用的预备输入直接结束，恢复不会把它当作待投递输入。
        if (known.conversationId === undefined) opts.getChannel().inbox.markInbound([key], "done");
      },
      async admit(transaction, candidate) {
        if (candidate.fire_key !== fire.fire_key) throw new Error("预备输入与触发标识不一致");
        const tx = transaction as Tx;
        const known = await tx.doc(AdmissionDoc, key, {});
        if (known.conversationId !== undefined) return { ticket: key };
        // 已结束的孤儿输入不得重新执行。
        if (opts.getChannel().inbox.getInbound(key)?.state !== "queued") return { ticket: key, skipped: true };
        const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
        Object.assign(await tx.doc(ScheduledRunDoc, conversation.id), {
          schedule_id: fire.schedule.id, fire_key: fire.fire_key, fire_at: fire.fire_at,
          ordinal: fire.ordinal, conversation: fire.schedule.conversation, created_by: fire.schedule.created_by,
          timeout_ms: fire.schedule.options.timeout_ms, input_key: key,
        });
        known.conversationId = conversation.id;
        return { ticket: key };
      },
    };
  }

  async function update(id: ConversationId, change: (run: RunState) => void): Promise<RunState> {
    await opts.getHarness().commit(async tx => { change(await tx.doc(ScheduledRunDoc, id)); }, ctx);
    return (await opts.getHarness().snapshot(ScheduledRunDoc, id, ctx))!;
  }

  /** 计算并回写结果；recordRun 按 fire_key 幂等覆盖，暂停回调也必须幂等。 */
  async function finish(key: string, outcome?: { status: TurnStatus; turnId?: string }): Promise<void> {
    const found = await readScheduledRun(opts.getHarness(), key);
    if (!found) return;
    const { conversationId: id } = found;
    let run: RunState = found;
    if (!run.result) {
      const turnId = outcome?.turnId ?? run.turn_id;
      const rows = turnId ? opts.getChannel().outbox.listOutboxByTurn(turnId).filter(row => !row.system) : [];
      const sent = rows.filter(row => row.status === "sent").length;
      // 不确定的投递不能算静默或成功；保留 Outbox 状态且永不重发。
      const deliveryFailed = rows.some(row => row.status !== "sent" || row.files.some(file => file.status !== "sent"));
      const turnFailed = !run.denied && (outcome?.status ?? "completed") !== "completed";
      const failed = run.denied || turnFailed || deliveryFailed;
      const record: ScheduleRun = {
        fire_key: run.fire_key, fire_at: run.fire_at, ticket: key, status: failed ? "failed" : sent ? "sent" : "silent",
        sent, ...(run.started_at !== undefined ? { started_at: run.started_at } : {}), ended_at: Date.now(),
        ...(failed && !run.denied ? { reason: "backend_failed" as const } : {}),
        note: run.denied ? "无权：创建者已无定时任务权限" : turnFailed ? (outcome?.status === "lost" ? "回合中断" : "回合失败") : "",
      };
      run = await update(id, state => { state.result = record; });
    }
    if (run.denied && !run.paused) {
      await opts.pauseSchedule(run.schedule_id, "无权：创建者已无定时任务权限");
      run = await update(id, state => { state.paused = true; });
    }
    if (!run.recorded) {
      await opts.recorder.recordRun(run.schedule_id, run.result!);
      run = await update(id, state => { state.recorded = true; });
      trace.event(run.turn_id ? "turn:" + run.turn_id : "in:" + key, "schedule_run", { status: run.result!.status, detail: {
        fire_key: run.fire_key, ordinal: run.ordinal, status: run.result!.status, sent: run.result!.sent, terminal: true,
      } });
    }
  }

  /**
   * 提交成功后（及启动恢复时）调用：按创建者当时的授权决定投递或以无权结束。
   * 已投递的输入重复投递是空操作；宿主中已结束的输入直接结算。
   */
  async function launch(key: string): Promise<void> {
    const run = await readScheduledRun(opts.getHarness(), key);
    if (!run) return;
    if (run.result || run.denied) { await finish(key); return; }
    // 升级前登记的运行没有定时输入：按中断结束，避免永久占用重叠判定。
    if (!opts.getChannel().inbox.getInbound(key)) { await finish(key, { status: "lost" }); return; }
    const state = await opts.inputState?.(key);
    if (state === "done") {
      // 宿主已结束该输入、结算尚未回写（崩溃）：按宿主记下的回合结果结算；没有结果记录时不能当作成功
      await finish(key, await opts.inputOutcome?.(key) ?? { status: "lost" });
      return;
    }
    // 投递前复核；已在宿主排队的输入由宿主开轮前再经 admit 复核
    if (state === undefined && !await admit(key)) return;
    await opts.deliver(key);
  }

  /** 创建者当前是否仍可定时（owner 会话只允许 owner）。 */
  async function allowed(run: RunState): Promise<boolean> {
    const senderIsOwner = isOwnerActor(owners(), run.created_by);
    return (run.conversation !== "owner" || senderIsOwner) &&
      (opts.canSchedule ? await opts.canSchedule(run.created_by, run.conversation) : senderIsOwner);
  }

  /**
   * 定时输入开轮前的准入复核（ThreadHost.admit，含重启恢复后的排队输入）：按创建者当前授权重查。
   * 无权 → 先持久化 denied，再结束输入、记失败并暂停；返回 false 时宿主不开轮。
   */
  async function admit(key: string): Promise<boolean> {
    const run = await readScheduledRun(opts.getHarness(), key);
    if (!run) return true;
    // 已结算的运行不再执行
    if (!run.denied && !run.result) {
      if (await allowed(run)) return true;
      await update(run.conversationId, s => { s.denied = true; s.started_at ??= Date.now(); });
    }
    opts.getChannel().inbox.markInbound([key], "done");
    await finish(key);
    return false;
  }

  /** 输入送达后端：记 running 与所在回合。 */
  async function delivered(key: string, turnId: string): Promise<void> {
    const found = await readScheduledRun(opts.getHarness(), key);
    if (!found || found.result) return;
    const run = await update(found.conversationId, s => { s.started_at ??= Date.now(); s.turn_id ??= turnId; });
    await opts.recorder.recordRun(run.schedule_id, {
      fire_key: run.fire_key, fire_at: run.fire_at, status: "running", started_at: run.started_at, ticket: key,
    });
  }

  /** 启动时：仍在途（queued/running）的运行重新驱动。须在宿主恢复之后调用。 */
  async function recover(): Promise<void> {
    const meta = await opts.getHarness().snapshot(ScheduleRuntimeDoc, ctx);
    for (const fireKey of Object.values(meta?.in_flight ?? {})) {
      const key = scheduledInputKey(fireKey);
      await launch(key).catch(error => log.warn("scheduled run recovery failed", { key, error }));
    }
  }

  return { prepare, launch, admit, delivered, finish, recover };
}

export type ScheduledRuntime = ReturnType<typeof createScheduledRuntime>;

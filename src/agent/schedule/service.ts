import { isScope } from "../../context/access.js";
import { log } from "../../shared/log.js";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { ConversationId, Harness, TaskId, Tx } from "@earendil-works/pi-durable";
import { ScheduleRuntimeDoc, SchedulesDoc } from "./docs.js";
import { DEFAULT_SCHEDULE_OPTIONS, parseCreate, parseUpdate, ScheduleError, validateRule } from "./model.js";
import { admitRun, prepareRun, type ScheduleTask } from "./task.js";
import { recordRunInTransaction, reportPaused } from "./records.js";
import type { Schedule, ScheduleConversation, ScheduledRunLauncher, ScheduleRun, ScheduleRunRecorder } from "./types.js";
import type { Trace } from "../../shared/trace.js";

export interface ScheduleServiceOptions {
  harness: Harness;
  task: ScheduleTask;
  admitter: ScheduledRunLauncher;
  /** QQ 号或 qq:<号>；授权服务未接入时只有 owner 可创建。 */
  owner?: string;
  canSchedule?: (actor: string, conversation: ScheduleConversation) => boolean | Promise<boolean>;
  now?: () => number;
  context?: Context;
  trace?: Pick<Trace, "event">;
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class ScheduleService implements ScheduleRunRecorder {
  private sweepTimer?: ReturnType<typeof setInterval>;
  private readonly ctx: Context;
  private readonly now: () => number;
  private readonly owner: string | undefined;
  constructor(private readonly opts: ScheduleServiceOptions) {
    this.ctx = opts.context ?? BACKGROUND_CONTEXT;
    this.now = opts.now ?? Date.now;
    this.owner = opts.owner?.replace(/^(?!qq:)/, "qq:");
  }

  /** 在 resume harness 前调用；专用会话只创建一次，已有检查点原样恢复。 */
  async start(): Promise<void> {
    await this.sweep();
    this.sweepTimer ??= setInterval(() => {
      void this.sweep().catch(error => log.error("schedule task sweep failed", { error }));
    }, 10 * 60_000);
    this.sweepTimer.unref();
  }

  stop(): void { clearInterval(this.sweepTimer); this.sweepTimer = undefined; }

  /** 启动与每十分钟修复 active 定义缺失或已终结的排程任务。 */
  private async sweep(): Promise<void> {
    await this.opts.harness.commit(async tx => {
      const meta = await tx.doc(ScheduleRuntimeDoc);
      const doc = await tx.doc(SchedulesDoc);
      const missing: Schedule[] = [];
      // durable 的表读取必须全部在表写入前完成。
      for (const schedule of Object.values(doc.schedules)) {
        if (schedule.status !== "active") continue;
        const id = meta.tasks[schedule.id], task = id === undefined ? undefined : await tx.task(id as TaskId);
        if (!task || task.state.status === "terminal") missing.push(schedule);
      }
      if (meta.conversation_id === null) meta.conversation_id = (await tx.createConversation({ ownership: { kind: "ownerless" } })).id;
      for (const schedule of missing) await this.schedule(tx, schedule);
    }, this.ctx);
  }

  async list(actor?: string): Promise<Schedule[]> {
    const doc = await this.opts.harness.snapshot(SchedulesDoc, this.ctx);
    return Object.values(doc?.schedules ?? {}).filter(s => actor === undefined || actor === this.owner || s.created_by === actor).map(copy);
  }

  async get(id: string, actor?: string): Promise<Schedule | undefined> {
    return (await this.list(actor)).find(s => s.id === id);
  }

  async create(actor: string, input: unknown): Promise<Schedule> {
    const fields = parseCreate(input);
    // 授权回调可能读取同一 harness 的 GrantsDoc，不能在占用提交队列时调用它。
    await this.authorize(actor, fields.conversation);
    const now = this.now(), next = validateRule(fields.rule, now, actor === this.owner);
    return this.opts.harness.commit(async tx => {
      const doc = await tx.doc(SchedulesDoc);
      this.quota(Object.values(doc.schedules), actor);
      const schedule: Schedule = {
        ...fields, options: { ...DEFAULT_SCHEDULE_OPTIONS, ...fields.options }, mode: "thread",
        id: randomUUID(), revision: 1, status: "active", next_fire_at: next,
        created_by: actor, created_at: now, updated_at: now, runs: [], failures: 0,
      };
      doc.schedules[schedule.id] = schedule;
      await this.schedule(tx, schedule);
      return copy(schedule);
    }, this.ctx);
  }

  async update(actor: string, id: string, input: unknown): Promise<Schedule> {
    const patch = parseUpdate(input);
    const snapshot = await this.authorizeRun(actor, id);
    const next = patch.rule || snapshot.status === "active"
      ? validateRule(patch.rule ?? snapshot.rule, this.now(), snapshot.created_by === this.owner) : null;
    return this.modify(actor, id, async (_tx, schedule) => {
      if (schedule.revision !== snapshot.revision) throw new ScheduleError(409, "定时任务已变更，请重试");
      Object.assign(schedule, patch, { options: { ...schedule.options, ...patch.options } });
      if (schedule.status === "active") schedule.next_fire_at = next;
    });
  }

  pause(actor: string, id: string, reason = "手动暂停"): Promise<Schedule> {
    return this.opts.harness.commit(async tx => {
      const schedule = this.editable((await tx.doc(SchedulesDoc)).schedules[id], actor);
      await this.pauseInTransaction(tx, schedule, reason);
      return copy(schedule);
    }, this.ctx);
  }

  /** 执行器失权后的内部暂停：删除后不重建，重放同一原因不再增加 revision 或重复告警。 */
  async pauseWithReason(id: string, reason: string): Promise<void> {
    const paused = await this.opts.harness.commit(async tx => {
      const schedule = (await tx.doc(SchedulesDoc)).schedules[id];
      if (!schedule || !Object.hasOwn(schedule, "id")) return undefined;
      return await this.pauseInTransaction(tx, schedule, reason) ? copy(schedule) : undefined;
    }, this.ctx);
    reportPaused(paused, this.opts.trace);
  }

  private async pauseInTransaction(tx: Tx, schedule: Schedule, reason: string): Promise<boolean> {
    if (schedule.status === "completed" || schedule.status === "paused" && schedule.pause_reason === reason) return false;
    schedule.status = "paused"; schedule.pause_reason = reason; schedule.next_fire_at = null;
    schedule.revision++; schedule.updated_at = this.now();
    delete (await tx.doc(ScheduleRuntimeDoc)).tasks[schedule.id];
    return true;
  }

  async resume(actor: string, id: string): Promise<Schedule> {
    const snapshot = await this.authorizeRun(actor, id);
    const next = validateRule(snapshot.rule, this.now(), snapshot.created_by === this.owner);
    return this.modify(actor, id, async (tx, schedule) => {
      if (schedule.revision !== snapshot.revision) throw new ScheduleError(409, "定时任务已变更，请重试");
      this.quota(Object.values((await tx.doc(SchedulesDoc)).schedules), schedule.created_by, id);
      schedule.next_fire_at = next;
      schedule.status = "active";
      schedule.failures = 0;
      delete schedule.pause_reason;
    });
  }

  async remove(actor: string, id: string): Promise<void> {
    await this.opts.harness.commit(async tx => {
      const doc = await tx.doc(SchedulesDoc);
      this.editable(doc.schedules[id], actor);
      delete doc.schedules[id];
      const meta = await tx.doc(ScheduleRuntimeDoc);
      delete meta.tasks[id]; delete meta.ordinals[id]; delete meta.in_flight[id];
      delete meta.last_result[id];
    }, this.ctx);
  }

  async runNow(actor: string, id: string): Promise<ScheduleRun> {
    const snapshot = await this.authorizeRun(actor, id);
    const fireAt = this.now();
    const prepared = await prepareRun(snapshot, await this.opts.harness.snapshot(ScheduleRuntimeDoc, this.ctx), fireAt, this.opts.admitter);
    let paused: Schedule | undefined;
    let run: ScheduleRun;
    try {
      run = await this.opts.harness.commit(async tx => {
        const schedule = this.editable((await tx.doc(SchedulesDoc)).schedules[id], actor);
        const revision = schedule.revision, now = this.now();
        if (schedule.revision !== snapshot.revision) throw new ScheduleError(409, "定时任务已变更，请重试");
        const result = await admitRun(tx, schedule, fireAt, now, prepared);
        if (!result) throw new ScheduleError(409, "定时运行序号已变更，请重试");
        if (schedule.revision !== revision && schedule.pause_reason === "连续 3 次失败") paused = copy(schedule);
        return copy(result);
      }, this.ctx);
    } finally {
      // 即使 revision/ordinal 冲突导致提交回滚，也必须结算未采用的预备票据。
      if (prepared?.admitter.discard) await this.opts.harness.commit(tx => prepared.admitter.discard!(tx), this.ctx);
    }
    reportPaused(paused, this.opts.trace);
    if (run.ticket && (run.status === "queued" || run.status === "running")) this.opts.admitter.dispatchScheduled(run.ticket);
    return run;
  }

  async recordRun(scheduleId: string, run: ScheduleRun): Promise<void> {
    const paused = await this.opts.harness.commit(tx => recordRunInTransaction(tx, scheduleId, run, this.now()), this.ctx);
    reportPaused(paused, this.opts.trace);
  }

  private async modify(actor: string, id: string, change: (tx: Tx, schedule: Schedule) => Promise<void>): Promise<Schedule> {
    return this.opts.harness.commit(async tx => {
      const schedule = this.editable((await tx.doc(SchedulesDoc)).schedules[id], actor);
      await change(tx, schedule);
      schedule.revision++;
      schedule.updated_at = this.now();
      const meta = await tx.doc(ScheduleRuntimeDoc);
      delete meta.tasks[id];
      if (schedule.status === "active") await this.schedule(tx, schedule);
      return copy(schedule);
    }, this.ctx);
  }

  private async schedule(tx: Tx, schedule: Schedule): Promise<void> {
    const meta = await tx.doc(ScheduleRuntimeDoc);
    if (meta.conversation_id === null) meta.conversation_id = (await tx.createConversation({ ownership: { kind: "ownerless" } })).id;
    meta.tasks[schedule.id] = await tx.createTask(this.opts.task, { id: schedule.id, revision: schedule.revision }, {
      conversationId: meta.conversation_id as ConversationId, ownership: { kind: "conversation" }, background: true,
    });
  }

  private editable(schedule: Schedule | undefined, actor: string): Schedule {
    if (!schedule || !Object.hasOwn(schedule, "id")) throw new ScheduleError(404, "定时任务不存在");
    if (actor !== this.owner && actor !== schedule.created_by) throw new ScheduleError(403, "只能管理自己创建的定时任务");
    return schedule;
  }

  private async authorize(actor: string, conversation: ScheduleConversation): Promise<void> {
    if (conversation === "owner" ? !this.owner : !isScope(conversation) || conversation !== conversation.trim()) {
      throw new ScheduleError(400, "定时任务 conversation 无效或未配置 owner");
    }
    if (!/^qq:[1-9]\d*$/.test(actor) || actor !== this.owner && !await this.opts.canSchedule?.(actor, conversation)) {
      throw new ScheduleError(403, "没有 schedule 授权");
    }
  }

  private async authorizeRun(actor: string, id: string): Promise<Schedule> {
    const schedule = this.editable(await this.get(id), actor);
    await this.authorize(actor, schedule.conversation);
    if (schedule.created_by !== actor) await this.authorize(schedule.created_by, schedule.conversation);
    return schedule;
  }

  private quota(schedules: Schedule[], actor: string, excluding?: string): void {
    if (actor !== this.owner && schedules.filter(s => s.id !== excluding && s.created_by === actor && s.status === "active").length >= 5) {
      throw new ScheduleError(409, "被授权人最多创建 5 条 active 定时任务");
    }
  }
}

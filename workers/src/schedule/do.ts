import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { cleanName, ownerIds, type InboundInput, type Target } from "../policy";
import { DEFAULT_SCHEDULE_OPTIONS, missedFires, nextFireAt, parseCreate, parseUpdate, validateRule } from "./model";
import { parseScheduleImport } from "./import";
import { scheduleInputKey, scheduledInput } from "./run";
import type { Schedule, ScheduleConversation, ScheduleRule, ScheduleRun, ScheduleRunStatus, ScheduleStatus } from "./types";

type ScheduleRow = {
  id: string; revision: number; name: string; prompt: string; conversation: ScheduleConversation; rule_json: string;
  status: ScheduleStatus; pause_reason: string | null; created_by: string; created_at: number; updated_at: number;
  next_fire_at: number | null; failures: number; fire_count: number;
};
type RunRow = {
  fire_key: string; schedule_id: string; fire_at: number; status: ScheduleRunStatus; reason: NonNullable<ScheduleRun["reason"]> | null;
  skipped_count: number | null; started_at: number | null; ended_at: number | null; sent: number | null; note: string | null; input_key: string | null;
};
export type ScheduleSummary = {
  active: number; paused: number; nextFireAt: number | null;
  lastFailure?: { id: string; name: string; fire_at: number; ended_at?: number };
};

const SETTLED: readonly ScheduleRunStatus[] = ["sent", "silent", "failed", "skipped"];
const settled = (status: ScheduleRunStatus) => SETTLED.includes(status);
const KEEP_RUNS = 20;
const FAILURE_LIMIT = 3;
const RUN_FIELDS = ["reason", "skipped_count", "started_at", "ended_at", "sent", "note", "input_key"] as const;

export class ScheduleDO extends DurableObject<Env> {
  private readonly sql = this.ctx.storage.sql;
  /** 正在投递的 fire_key：投递完成前 ThreadDO 里还查不到输入，不能当作丢失。 */
  private readonly delivering = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY, revision INTEGER NOT NULL, name TEXT NOT NULL, prompt TEXT NOT NULL, conversation TEXT NOT NULL,
        rule_json TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed')), pause_reason TEXT,
        created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, next_fire_at INTEGER,
        failures INTEGER NOT NULL DEFAULT 0, fire_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS schedule_imports (id TEXT PRIMARY KEY, hash TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS schedules_due ON schedules(status, next_fire_at);
      CREATE TABLE IF NOT EXISTS schedule_runs (
        fire_key TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, fire_at INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT,
        skipped_count INTEGER, started_at INTEGER, ended_at INTEGER, sent INTEGER, note TEXT, input_key TEXT
      );
      CREATE INDEX IF NOT EXISTS schedule_runs_schedule ON schedule_runs(schedule_id, fire_at);
    `);
  }

  async list(conversation?: ScheduleConversation): Promise<Schedule[]> {
    const rows = conversation === undefined
      ? this.sql.exec<ScheduleRow>("SELECT * FROM schedules ORDER BY created_at, id").toArray()
      : this.sql.exec<ScheduleRow>("SELECT * FROM schedules WHERE conversation = ? ORDER BY created_at, id", conversation).toArray();
    return rows.map(row => this.toSchedule(row));
  }

  /** 整批原子导入；凭源快照摘要识别重试，不覆盖云端后续修改。 */
  async importSchedules(input: unknown) {
    let parsed;
    try { parsed = parseScheduleImport(input, Date.now()); }
    catch { return { error: "invalid_import" as const }; }
    const plans = await Promise.all(parsed.schedules.map(async item => ({ ...item,
      hash: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(item.source))),
        byte => byte.toString(16).padStart(2, "0")).join(""),
    })));
    const result = this.ctx.storage.transactionSync(() => {
      const items = [];
      for (const { schedule, hash } of plans) {
        const receipt = this.sql.exec<{ hash: string }>("SELECT hash FROM schedule_imports WHERE id = ?", schedule.id).toArray()[0];
        const exists = this.sql.exec("SELECT id FROM schedules WHERE id = ?", schedule.id).toArray().length > 0;
        if (receipt ? receipt.hash !== hash || !exists : exists) return { error: "schedule_conflict" as const };
        const current = exists ? this.toSchedule(this.row(schedule.id)) : schedule;
        items.push({ id: schedule.id, name: current.name, status: current.status, next_fire_at: current.next_fire_at,
          action: receipt ? "skip" as const : "import" as const });
      }
      if (!parsed.dryRun) for (const { schedule: s, hash, fireCount } of plans) {
        if (items.find(item => item.id === s.id)?.action === "skip") continue;
        this.sql.exec("INSERT INTO schedules (id, revision, name, prompt, conversation, rule_json, status, pause_reason, created_by, created_at, updated_at, next_fire_at, failures, fire_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          s.id, s.revision, s.name, s.prompt, s.conversation, JSON.stringify(s.rule), s.status, s.pause_reason ?? null,
          s.created_by, s.created_at, s.updated_at, s.next_fire_at, s.failures, fireCount);
        for (const run of s.runs) this.sql.exec(
          "INSERT INTO schedule_runs (fire_key, schedule_id, fire_at, status, " + RUN_FIELDS.join(", ") + ") VALUES (?, ?, ?, ?, " + RUN_FIELDS.map(() => "?").join(", ") + ")",
          run.fire_key, s.id, run.fire_at, run.status, ...RUN_FIELDS.map(field => run[field] ?? null));
        this.sql.exec("INSERT INTO schedule_imports (id, hash) VALUES (?, ?)", s.id, hash);
      }
      return { dryRun: parsed.dryRun, imported: parsed.dryRun ? 0 : items.filter(item => item.action === "import").length,
        skipped: items.filter(item => item.action === "skip").length, items };
    });
    if (!("error" in result) && !parsed.dryRun) {
      await this.arm();
      console.log({ event: "schedule_import", imported: result.imported, skipped: result.skipped });
    }
    return result;
  }

  async create(input: unknown, by: string): Promise<Schedule> {
    const fields = parseCreate(input), now = Date.now();
    if (!/^qq:[1-9]\d{0,15}$/.test(by)) throw new Error("创建者无效");
    const next = validateRule(fields.rule, now), id = crypto.randomUUID();
    this.sql.exec(`INSERT INTO schedules (id, revision, name, prompt, conversation, rule_json, status, created_by, created_at, updated_at, next_fire_at)
      VALUES (?, 1, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`, id, fields.name, fields.prompt, fields.conversation, JSON.stringify(fields.rule), by, now, now, next);
    await this.changed("create", id, by);
    return this.toSchedule(this.row(id));
  }

  async update(id: string, patch: unknown, by: string): Promise<Schedule> {
    const fields = parseUpdate(patch), row = this.row(id), rule = fields.rule ?? this.rule(row);
    const next = fields.rule || row.status === "active" ? validateRule(rule, Date.now()) : null;
    this.sql.exec(`UPDATE schedules SET name = ?, prompt = ?, rule_json = ?, next_fire_at = CASE WHEN status = 'active' THEN ? ELSE next_fire_at END,
      revision = revision + 1, updated_at = ? WHERE id = ?`, fields.name ?? row.name, fields.prompt ?? row.prompt, JSON.stringify(rule), next, Date.now(), id);
    await this.changed("update", id, by);
    return this.toSchedule(this.row(id));
  }

  async setStatus(id: string, status: ScheduleStatus, reason: string | undefined, by: string): Promise<Schedule> {
    const row = this.row(id), now = Date.now();
    if (status === "active") {
      // 恢复从现在往后算，停机或暂停期间错过的不补跑。
      const next = validateRule(this.rule(row), now);
      this.sql.exec("UPDATE schedules SET status = 'active', pause_reason = NULL, failures = 0, next_fire_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?", next, now, id);
    } else if (row.status !== status && !(status === "paused" && row.status === "completed")) {
      this.sql.exec("UPDATE schedules SET status = ?, pause_reason = ?, next_fire_at = NULL, revision = revision + 1, updated_at = ? WHERE id = ?",
        status, status === "paused" ? reason?.slice(0, 200) || "manual" : null, now, id);
    }
    await this.changed(status, id, by);
    return this.toSchedule(this.row(id));
  }

  async remove(id: string, by: string): Promise<void> {
    this.row(id);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM schedule_runs WHERE schedule_id = ?", id);
      this.sql.exec("DELETE FROM schedules WHERE id = ?", id);
    });
    await this.changed("delete", id, by);
  }

  async runNow(id: string, by: string): Promise<ScheduleRun> {
    const row = this.row(id), now = Date.now();
    console.log({ event: "schedule_change", action: "run_now", id, by });
    return this.fire(row, now);
  }

  /** ThreadDO 在定时回合结束时回写；按 fire_key 幂等，迟到的在途状态不能覆盖终态。 */
  async recordRun(scheduleId: string, run: ScheduleRun): Promise<void> {
    const paused = this.apply(scheduleId, run);
    if (paused) await this.alert(paused);
    await this.arm();
  }

  async status(): Promise<ScheduleSummary> {
    const counts = this.sql.exec<{ status: ScheduleStatus; n: number }>("SELECT status, COUNT(*) AS n FROM schedules GROUP BY status").toArray();
    const next = this.sql.exec<{ at: number | null }>("SELECT MIN(next_fire_at) AS at FROM schedules WHERE status = 'active'").one().at;
    const failure = this.sql.exec<{ id: string; name: string; fire_at: number; ended_at: number | null }>(`SELECT s.id, s.name, r.fire_at, r.ended_at
      FROM schedule_runs r JOIN schedules s ON s.id = r.schedule_id WHERE r.status = 'failed' ORDER BY r.ended_at DESC, r.fire_at DESC LIMIT 1`).toArray()[0];
    return {
      active: counts.find(row => row.status === "active")?.n ?? 0, paused: counts.find(row => row.status === "paused")?.n ?? 0, nextFireAt: next,
      ...(failure ? { lastFailure: { id: failure.id, name: failure.name, fire_at: failure.fire_at, ...(failure.ended_at === null ? {} : { ended_at: failure.ended_at }) } } : {}),
    };
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const due = this.sql.exec<ScheduleRow>("SELECT * FROM schedules WHERE status = 'active' AND next_fire_at <= ? ORDER BY next_fire_at", now).toArray();
    for (const row of due) {
      try { await this.fireDue(row, now); }
      catch (error) {
        // 规则在保存时已校验，到这里仍抛错只能暂停，否则过去的 next_fire_at 会让 alarm 立刻重入。
        console.error({ event: "schedule_fire_failed", id: row.id, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
        this.sql.exec("UPDATE schedules SET status = 'paused', pause_reason = 'error', next_fire_at = NULL, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?", Date.now(), row.id, row.revision);
      }
    }
    await this.arm();
  }

  private async fireDue(row: ScheduleRow, now: number): Promise<void> {
    const fireAt = row.next_fire_at!, rule = this.rule(row);
    if (now - fireAt > DEFAULT_SCHEDULE_OPTIONS.stale_after_ms) this.recordStale(row, rule, fireAt, now);
    else await this.fire(row, fireAt);
    // 投递期间任务可能被修改或删除；修改方已重算 next_fire_at，只有 revision 未变才由这里推进。
    const next = nextFireAt(rule, now);
    this.sql.exec(`UPDATE schedules SET next_fire_at = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END, updated_at = ?
      WHERE id = ? AND revision = ? AND status = 'active'`, next, next, Date.now(), row.id, row.revision);
  }

  private recordStale(row: ScheduleRow, rule: ScheduleRule, fireAt: number, now: number): void {
    const count = missedFires(rule, fireAt, now);
    const previous = this.sql.exec<RunRow>("SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY fire_at DESC LIMIT 1", row.id).toArray()[0];
    const interval = (nextFireAt(rule, fireAt) ?? fireAt) - fireAt;
    // 连续停机只留一条 stale 记录，累计错过次数。
    if (previous?.status === "skipped" && previous.reason === "stale" && previous.ended_at !== null &&
        fireAt >= previous.ended_at && fireAt - previous.ended_at <= interval) {
      this.sql.exec("UPDATE schedule_runs SET skipped_count = COALESCE(skipped_count, 1) + ?, ended_at = ? WHERE fire_key = ?", count, now, previous.fire_key);
    } else {
      this.apply(row.id, { fire_key: `${row.id}@${fireAt}`, fire_at: fireAt, status: "skipped", reason: "stale", skipped_count: count, ended_at: now });
    }
  }

  /** 先写 run 再投递：投递前崩溃时 next_fire_at 未推进，下次 alarm 以同一入站键重投，由 ThreadDO 去重。 */
  private async fire(row: ScheduleRow, fireAt: number): Promise<ScheduleRun> {
    const fireKey = `${row.id}@${fireAt}`, inputKey = scheduleInputKey(fireKey);
    const existing = this.runRow(fireKey);
    if (existing && existing.status !== "queued") return this.toRun(existing);
    if (!existing) {
      for (const previous of this.inFlight(row.id)) await this.reconcile(row, previous);
      if (this.inFlight(row.id).length) {
        this.apply(row.id, { fire_key: fireKey, fire_at: fireAt, status: "skipped", reason: "overlap", ended_at: Date.now() });
        return this.toRun(this.runRow(fireKey)!);
      }
      this.ctx.storage.transactionSync(() => {
        this.sql.exec("UPDATE schedules SET fire_count = fire_count + 1 WHERE id = ?", row.id);
        this.sql.exec("INSERT INTO schedule_runs (fire_key, schedule_id, fire_at, status, input_key) VALUES (?, ?, ?, 'queued', ?)", fireKey, row.id, fireAt, inputKey);
      });
    }
    const current = this.row(row.id);
    this.delivering.add(fireKey);
    try {
      const result = await this.env.THREAD.getByName(current.conversation).submit(await this.input(current, fireAt, inputKey));
      if ("status" in result && result.status === "failed") throw new Error("admission_failed");
    } catch (error) {
      console.error({ event: "schedule_deliver_failed", id: row.id, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
      const paused = this.apply(row.id, { fire_key: fireKey, fire_at: fireAt, status: "failed", reason: "backend_failed", ended_at: Date.now(), note: "投递失败", input_key: inputKey });
      if (paused) await this.alert(paused);
    } finally {
      this.delivering.delete(fireKey);
    }
    return this.toRun(this.runRow(fireKey)!);
  }

  private async input(row: ScheduleRow, fireAt: number, inputKey: string): Promise<InboundInput> {
    const conversation = row.conversation, owner = ownerIds(this.env)[0];
    let target: Target;
    if (conversation === "owner") {
      if (!owner) throw new Error("owner_missing");
      target = { kind: "private", userId: owner };
    } else {
      const [kind, chat] = conversation.split(":") as ["group" | "private", string];
      target = kind === "group" ? { kind: "group", groupId: chat } : { kind: "private", userId: chat };
    }
    // selfId 只用于记录机器人发出的消息；Bridge 不可用时仍可执行，留空即可。
    const selfId = await this.env.BRIDGE.getByName("napcat").status().then(status => status.selfId ?? "", () => "");
    const text = scheduledInput(this.toSchedule(row), fireAt, row.fire_count);
    return { messageId: inputKey, selfId, userId: row.created_by.replace(/^qq:/, ""), nickname: "定时任务", target, text, routeText: text,
      time: Math.floor(fireAt / 1000), mentionedSelf: false, replyToId: null, imageCount: 0, kind: "schedule", meta: { fireKey: `${row.id}@${fireAt}` } };
  }

  /** 回写丢失（结算后、回写前被驱逐）时，下一次触发前向 ThreadDO 补查结果，避免永远 overlap。 */
  private async reconcile(row: ScheduleRow, run: RunRow): Promise<void> {
    if (this.delivering.has(run.fire_key)) return;
    const key = run.input_key ?? scheduleInputKey(run.fire_key);
    let outcome;
    try { outcome = await this.env.THREAD.getByName(row.conversation).scheduleRunOutcome(key); }
    catch { return; }
    if (outcome.status === "queued") return;
    const base = { fire_key: run.fire_key, fire_at: run.fire_at, input_key: key, ended_at: Date.now() };
    const paused = this.apply(row.id, outcome.status === "missing" ? { ...base, status: "skipped", reason: "interrupted", note: "定时输入丢失，未执行" }
      : outcome.status === "failed" ? { ...base, status: "failed", sent: outcome.sent } : { ...base, status: outcome.sent ? "sent" : "silent", sent: outcome.sent });
    if (paused) await this.alert(paused);
  }

  /** 返回本次写入导致自动暂停的任务（只在 active→paused 时返回一次，告警据此只发一次）。 */
  private apply(scheduleId: string, run: ScheduleRun): Schedule | undefined {
    if (run.fire_key !== `${scheduleId}@${run.fire_at}`) throw new Error("fire_key 与定时任务不匹配");
    const paused = this.ctx.storage.transactionSync(() => {
      const schedule = this.sql.exec<ScheduleRow>("SELECT * FROM schedules WHERE id = ?", scheduleId).toArray()[0];
      // 删除后迟到的执行结果不得重建记录。
      if (!schedule) return false;
      const previous = this.runRow(run.fire_key);
      if (previous && settled(previous.status) && !settled(run.status)) return false;
      const merged = { ...(previous ? this.toRun(previous) : {}), ...run, ...(run.note === undefined ? {} : { note: run.note.slice(0, 200) }) };
      this.sql.exec(`INSERT OR REPLACE INTO schedule_runs (fire_key, schedule_id, fire_at, status, ${RUN_FIELDS.join(", ")})
        VALUES (?, ?, ?, ?, ${RUN_FIELDS.map(() => "?").join(", ")})`, merged.fire_key, scheduleId, merged.fire_at, merged.status,
        ...RUN_FIELDS.map(field => merged[field] ?? null));
      // 在途记录必须保留；只裁剪最早的终态记录。
      this.sql.exec(`DELETE FROM schedule_runs WHERE schedule_id = ? AND status IN ('sent', 'silent', 'failed', 'skipped') AND fire_key NOT IN (
        SELECT fire_key FROM schedule_runs WHERE schedule_id = ? AND status IN ('sent', 'silent', 'failed', 'skipped') ORDER BY fire_at DESC LIMIT ?)`, scheduleId, scheduleId, KEEP_RUNS);
      // 终态重放不再计数，只有在途→终态的那一次改变失败计数。
      if (previous && settled(previous.status) || !["sent", "silent", "failed"].includes(run.status)) return false;
      const failures = run.status === "failed" ? schedule.failures + 1 : 0;
      this.sql.exec("UPDATE schedules SET failures = ?, updated_at = ? WHERE id = ?", failures, Date.now(), scheduleId);
      if (failures < FAILURE_LIMIT || schedule.status !== "active") return false;
      this.sql.exec("UPDATE schedules SET status = 'paused', pause_reason = 'failures', next_fire_at = NULL, revision = revision + 1 WHERE id = ?", scheduleId);
      return true;
    });
    return paused ? this.toSchedule(this.row(scheduleId)) : undefined;
  }

  private async alert(schedule: Schedule): Promise<void> {
    const owner = ownerIds(this.env)[0];
    console.error({ event: "schedule_paused", id: schedule.id, reason: "failures", failures: schedule.failures });
    if (!owner) return;
    try {
      await this.env.BRIDGE.getByName("napcat").sendPrivate(owner, `定时任务「${cleanName(schedule.name)}」连续 ${FAILURE_LIMIT} 次运行失败，已自动暂停。确认问题后可在聊天或管理端点恢复。`);
    } catch (error) {
      console.error({ event: "schedule_alert_failed", id: schedule.id, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
    }
  }

  private async changed(action: string, id: string, by: string): Promise<void> {
    console.log({ event: "schedule_change", action, id, by });
    await this.arm();
  }

  private async arm(): Promise<void> {
    const at = this.sql.exec<{ at: number | null }>("SELECT MIN(next_fire_at) AS at FROM schedules WHERE status = 'active'").one().at;
    if (at === null) await this.ctx.storage.deleteAlarm();
    else if (await this.ctx.storage.getAlarm() !== at) await this.ctx.storage.setAlarm(at);
  }

  private row(id: string): ScheduleRow {
    const row = this.sql.exec<ScheduleRow>("SELECT * FROM schedules WHERE id = ?", id).toArray()[0];
    if (!row) throw new Error("定时任务不存在");
    return row;
  }
  private rule(row: ScheduleRow): ScheduleRule {
    return JSON.parse(row.rule_json) as ScheduleRule;
  }
  private runRow(fireKey: string): RunRow | undefined {
    return this.sql.exec<RunRow>("SELECT * FROM schedule_runs WHERE fire_key = ?", fireKey).toArray()[0];
  }
  private inFlight(scheduleId: string): RunRow[] {
    return this.sql.exec<RunRow>("SELECT * FROM schedule_runs WHERE schedule_id = ? AND status IN ('queued', 'running') ORDER BY fire_at", scheduleId).toArray();
  }
  private toRun(row: RunRow): ScheduleRun {
    const run: ScheduleRun = { fire_key: row.fire_key, fire_at: row.fire_at, status: row.status };
    for (const field of RUN_FIELDS) if (row[field] !== null) Object.assign(run, { [field]: row[field] });
    return run;
  }
  private toSchedule(row: ScheduleRow): Schedule {
    const runs = this.sql.exec<RunRow>("SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY fire_at", row.id).toArray().map(run => this.toRun(run));
    return { id: row.id, revision: row.revision, name: row.name, prompt: row.prompt, conversation: row.conversation, rule: this.rule(row),
      status: row.status, ...(row.pause_reason === null ? {} : { pause_reason: row.pause_reason }), mode: "thread", options: { ...DEFAULT_SCHEDULE_OPTIONS },
      created_by: row.created_by, created_at: row.created_at, updated_at: row.updated_at, next_fire_at: row.next_fire_at, failures: row.failures, runs };
  }
}

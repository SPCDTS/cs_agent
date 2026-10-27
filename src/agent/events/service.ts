import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import type { EventInput, InboundRecord } from "../../channel/types.js";
import type { OutboxRow } from "../../channel/outbox.js";
import { trace, type Trace } from "../../shared/trace.js";
import type { TurnStatus } from "../host/types.js";
import { turnResult } from "../turn-result.js";
import { EventRunDoc, EventsDoc, emptyCounts, newSourceState, type EventCounts, type EventRun, type EventSourceState } from "./docs.js";
import { renderEventInput } from "./render.js";
import { EventManagementError, EventSourceError, eventSourceIdSchema, eventSourceSettingsSchema, externalEventSchema, type EventSource, type ExternalEvent } from "./types.js";

const ctx = BACKGROUND_CONTEXT, HOUR = 3_600_000;
export const eventInputKey = (source: string, id: string) => `evt_${source}_${createHash("sha256").update(id).digest("hex").slice(0, 40)}`;
type Outcome = { status: TurnStatus; turnId?: string };
export interface EventServiceOptions {
  harness: Pick<Harness, "snapshot" | "commit">;
  inbox: {
    get(key: string): InboundRecord | null;
    insert(input: EventInput): InboundRecord;
    deliver(key: string): Promise<void>;
  };
  owner: string; sources: EventSource[]; now?: () => number; trace?: Pick<Trace, "event">;
  /** 与 ThreadHost 同源的会话后端；未选定时也不投递。 */
  ownerBackend(): Promise<string | undefined>;
  outbox?: (turnId: string) => OutboxRow[];
  inputOutcome?: (key: string) => Promise<Outcome | undefined>;
}

/** 单进程唯一写入者；网络请求不占提交队列，状态更新与投递按来源串行。 */
export class EventService {
  private readonly sources = new Map<string, EventSource>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly polls = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly pollTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = false;
  private stopped = false;
  private readonly now: () => number;
  constructor(private readonly opts: EventServiceOptions) {
    this.now = opts.now ?? Date.now;
    if (!/^[1-9][0-9]{0,19}$/.test(opts.owner)) throw new Error("事件服务缺少 owner");
    for (const source of opts.sources) {
      eventSourceIdSchema.parse(source.id);
      if (this.sources.has(source.id)) throw new Error("事件来源重复");
      this.sources.set(source.id, source);
    }
  }
  private event(stage: string, detail: Record<string, unknown>) { (this.opts.trace ?? trace).event("@events", stage, { detail }); }
  private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const result = (this.chains.get(id) ?? Promise.resolve()).catch(() => undefined).then(work);
    const tail = result.then(() => undefined, () => undefined);
    this.chains.set(id, tail);
    void tail.then(() => { if (this.chains.get(id) === tail) this.chains.delete(id); });
    return result;
  }
  private async state(id: string): Promise<EventSourceState> {
    if (!this.sources.has(id)) throw new EventManagementError(404, "事件来源不存在");
    const state = (await this.opts.harness.snapshot(EventsDoc, ctx))?.sources[id];
    if (!state) throw new EventManagementError(503, "事件服务未启动");
    return structuredClone(state);
  }
  private async save(id: string, state: EventSourceState): Promise<void> {
    await this.opts.harness.commit(async tx => { (await tx.doc(EventsDoc)).sources[id] = state; }, ctx);
  }
  private count(state: EventSourceState, key: keyof EventCounts, n = 1) {
    const at = Math.floor(this.now() / HOUR) * HOUR;
    state.stats.buckets = state.stats.buckets.filter(bucket => bucket.at > at - 24 * HOUR);
    let bucket = state.stats.buckets.find(bucket => bucket.at === at);
    if (!bucket) { bucket = { at, counts: emptyCounts() }; state.stats.buckets.push(bucket); }
    bucket.counts[key] += n;
    state.stats.counts24h = emptyCounts();
    for (const bucket of state.stats.buckets) for (const name of Object.keys(bucket.counts) as (keyof EventCounts)[]) state.stats.counts24h[name] += bucket.counts[name];
  }
  private hour(state: EventSourceState) {
    if (this.now() - state.stats.hourWindowStart >= HOUR) { state.stats.hourWindowStart = this.now(); state.stats.deliveredInHour = 0; }
  }
  private enabled(state: EventSourceState) { return state.enabled && state.settings.enabled && !state.stats.pausedReason; }
  async start(): Promise<void> {
    if (this.running) return;
    this.stopped = false;
    await this.opts.harness.commit(async tx => {
      const doc = await tx.doc(EventsDoc);
      for (const id of this.sources.keys()) {
        doc.sources[id] ??= newSourceState(this.now());
        doc.sources[id].settings = eventSourceSettingsSchema.parse(doc.sources[id].settings);
      }
    }, ctx);
    this.running = true;
    for (const id of this.sources.keys()) {
      await this.serial(id, () => this.flush(id));
      await this.schedulePoll(id);
    }
  }
  async stop(): Promise<void> {
    this.stopped = true; this.running = false;
    for (const timer of [...this.pollTimers.values(), ...this.flushTimers.values()]) clearTimeout(timer);
    this.pollTimers.clear(); this.flushTimers.clear();
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.polls.values(), ...this.chains.values()]);
  }
  async list() {
    const result = [];
    for (const id of this.sources.keys()) {
      const state = await this.state(id); this.hour(state); this.count(state, "delivered", 0);
      result.push({ id, ...state });
    }
    return result;
  }
  async recentRuns(limit = 50): Promise<(EventRun & { key: string })[]> {
    if (limit <= 0) return [];
    const keys = (await this.opts.harness.snapshot(EventsDoc, ctx))?.runs ?? [];
    const runs = await Promise.all(keys.slice(-Math.max(0, Math.min(200, limit))).reverse().map(async key => {
      const run = await this.opts.harness.snapshot(EventRunDoc, key, ctx);
      return run?.source ? { key, ...structuredClone(run) } : undefined;
    }));
    return runs.filter(run => run !== undefined);
  }
  async pause(id: string): Promise<void> {
    await this.serial(id, async () => {
      const state = await this.state(id); state.enabled = false; state.stats.pausedReason = "手动暂停";
      await this.save(id, state); this.event("event_source_state", { source: id, state: "paused", reason: "manual" });
    });
    clearTimeout(this.pollTimers.get(id)); clearTimeout(this.flushTimers.get(id)); this.controllers.get(id)?.abort();
  }
  async resume(id: string): Promise<void> {
    await this.serial(id, async () => {
      const state = await this.state(id); state.enabled = true; state.settings.enabled = true;
      delete state.stats.pausedReason; state.stats.consecutiveTurnFailures = 0;
      await this.save(id, state); this.event("event_source_state", { source: id, state: "enabled" });
      await this.flush(id);
    });
    await this.schedulePoll(id);
  }
  private async schedulePoll(id: string) {
    clearTimeout(this.pollTimers.get(id));
    const state = await this.state(id);
    if (!this.running || !this.enabled(state) || !this.sources.get(id)?.poll) return;
    const base = Math.min(30 * 60_000, state.settings.intervalS * 1000 * 2 ** Math.min(10, state.stats.consecutivePollFailures));
    const timer = setTimeout(() => { void this.pollNow(id).catch(() => undefined); }, Math.min(30 * 60_000, base * (0.9 + Math.random() * 0.2)));
    timer.unref(); this.pollTimers.set(id, timer);
  }
  pollNow(id: string): Promise<void> {
    const prior = this.polls.get(id);
    if (prior) return prior;
    const task = this.poll(id).finally(async () => { this.polls.delete(id); if (!this.stopped) await this.schedulePoll(id); });
    this.polls.set(id, task); return task;
  }
  private async poll(id: string) {
    const source = this.sources.get(id);
    if (!source?.poll) throw new EventManagementError(404, "轮询来源不存在");
    if (!this.enabled(await this.state(id)) || this.stopped) throw new EventManagementError(409, "事件来源已暂停");
    clearTimeout(this.pollTimers.get(id));
    await this.serial(id, () => this.flush(id));
    for (let page = 0; page < 5; page++) {
      const state = await this.state(id);
      if (!this.enabled(state) || this.stopped) return;
      const started = this.now(), controller = new AbortController(); this.controllers.set(id, controller);
      const timer = setTimeout(() => controller.abort(), 30_000); timer.unref();
      let abort!: () => void;
      try {
        // 即使来源忽略 signal，超时和关闭也能结束宿主等待；迟到响应不写状态。
        const cancelled = new Promise<never>((_, reject) => {
          abort = () => reject(new EventSourceError("timeout")); controller.signal.addEventListener("abort", abort, { once: true });
        });
        const result = await Promise.race([source.poll(state.pendingCursor ?? state.cursor, 50, controller.signal), cancelled]);
        controller.signal.throwIfAborted();
        await this.serial(id, async () => {
          if (this.stopped) return;
          await this.accept(id, result.reset ? [] : result.events, result.cursor, result.reset === true);
          const state = await this.state(id); state.stats.lastPollAt = this.now(); state.stats.lastPollStatus = result.reset ? "reset" : "ok";
          state.stats.consecutivePollFailures = 0;
          if (state.stats.degraded && !state.stats.blockedReason) this.event("event_source_state", { source: id, state: "enabled", reason: "poll_recovered" });
          state.stats.degraded = !!state.stats.blockedReason; await this.save(id, state);
        });
        this.event("event_poll", { source: id, status: result.reset ? "reset" : "ok", fetched: result.events.length, durationMs: this.now() - started });
        if (!result.more || result.reset) return;
      } catch (error) {
        if (this.stopped || !this.enabled(await this.state(id))) return;
        await this.serial(id, async () => {
          const state = await this.state(id); state.stats.lastPollAt = this.now(); state.stats.lastPollStatus = "failed";
          state.stats.consecutivePollFailures++;
          if (state.stats.consecutivePollFailures === 3) {
            state.stats.degraded = true; this.event("event_source_state", { source: id, state: "degraded", reason: "poll_failed" });
          }
          await this.save(id, state);
        });
        this.event("event_poll", { source: id, status: "failed", fetched: 0, durationMs: this.now() - started, code: error instanceof EventSourceError ? error.code : "failed" });
        throw new EventManagementError(502, "事件轮询失败");
      } finally { clearTimeout(timer); controller.signal.removeEventListener("abort", abort); this.controllers.delete(id); }
    }
  }
  ingest(source: string, events: readonly unknown[]): Promise<void> { return this.serial(source, () => this.accept(source, events)); }
  private async accept(id: string, incoming: readonly unknown[], cursor?: string, reset = false) {
    if (this.stopped) return;
    const state = await this.state(id);
    const seen = new Set([...state.held.map(event => eventInputKey(id, event.externalId)), ...state.extraKeys]);
    for (const value of incoming) {
      const parsed = externalEventSchema.safeParse(value);
      if (!parsed.success || parsed.data.source !== id) { this.event("event_rejected", { source: id, code: "shape" }); continue; }
      const event = parsed.data, key = eventInputKey(id, event.externalId);
      const received = (decision: string) => this.event("event_received", { source: id, kind: event.kind, decision, key });
      if (seen.has(key) || this.opts.inbox.get(key)) { this.count(state, "deduped"); received("deduped"); continue; }
      seen.add(key);
      const filters = state.settings.filters, labels = event.labels ?? [];
      if (filters.requireLabels.some(label => !labels.includes(label)) || filters.excludeLabels.some(label => labels.includes(label)) ||
          filters.excludeSenders.some(sender => event.actor?.toLowerCase().includes(sender.toLowerCase()))) {
        this.count(state, "suppressed"); received("suppressed"); continue;
      }
      state.held.push(event); state.mergeAt ??= this.now() + state.settings.mergeWindowS * 1000;
      if (state.held.length > 200) {
        state.held.shift(); this.event("event_source_state", { source: id, state: "overflow", reason: "held_limit" });
      }
      received("held");
    }
    if (cursor !== undefined) state.pendingCursor = cursor;
    // reset 不覆盖已有积压；其游标随积压完成一起确认。
    if (!state.held.length && !state.extraCount && cursor !== undefined) { state.cursor = cursor; delete state.pendingCursor; }
    if (reset) state.stats.lastPollStatus = "reset";
    await this.save(id, state);
    await this.flush(id);
  }
  private quietDelay(state: EventSourceState): number {
    const quiet = state.settings.quietHours;
    if (!quiet || quiet.start === quiet.end) return 0;
    const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    const local = new Date(this.now() + 8 * HOUR), minute = local.getUTCHours() * 60 + local.getUTCMinutes();
    const start = minutes(quiet.start), end = minutes(quiet.end);
    const inside = start < end ? minute >= start && minute < end : minute >= start || minute < end;
    return inside ? ((end - minute + 1440) % 1440) * 60_000 - local.getUTCSeconds() * 1000 - local.getUTCMilliseconds() : 0;
  }
  private defer(id: string, delay: number) {
    if (!this.running) return;
    const timer = setTimeout(() => {
      void this.serial(id, () => this.flush(id)).catch(() => {
        this.event("event_source_state", { source: id, state: "retry", reason: "delivery_failed" }); this.defer(id, 30_000);
      });
    }, Math.max(1, delay)); timer.unref(); this.flushTimers.set(id, timer);
  }
  private async flush(id: string): Promise<void> {
    clearTimeout(this.flushTimers.get(id));
    if (this.stopped) return;
    // 入站与 run 已提交、投递或结算通知未完成时，继续同键操作；不能等到进程重启才恢复。
    try {
      for (const run of await this.recentRuns(200)) {
        if (run.source !== id || run.result) continue;
        const outcome = await this.opts.inputOutcome?.(run.key);
        if (outcome) await this.finishState(run.key, outcome);
        else if (this.opts.inbox.get(run.key)?.state === "queued") await this.opts.inbox.deliver(run.key);
      }
    } catch (error) { this.defer(id, 30_000); throw error; }
    let state = await this.state(id);
    if (!this.enabled(state)) return;
    if (!await this.backendReady(id, state) || !state.held.length) return;
    const delay = Math.max(this.quietDelay(state), (state.mergeAt ?? 0) - this.now());
    if (delay > 0) { this.defer(id, delay); return; }
    this.hour(state);
    while (state.held.length) {
      if (!await this.backendReady(id, state)) return;
      if (state.stats.deliveredInHour >= state.settings.budgetPerHour) {
        // 超额只计未展开数，等下一条正常输入一起通知；去重键有界持久化。
        const budgeted = state.held.splice(0);
        for (const event of budgeted) {
          const key = eventInputKey(id, event.externalId);
          if (state.extraCount < 999) { state.extraCount++; state.extraKeys.push(key); }
          this.event("event_received", { source: id, kind: event.kind, decision: "budgeted", key });
        }
        delete state.mergeAt;
        await this.save(id, state); return;
      }
      const events = state.held.slice(0, 10), head = events[0]!;
      const key = eventInputKey(id, head.externalId), eventKeys = [...events.map(event => eventInputKey(id, event.externalId)), ...state.extraKeys];
      const extraCount = state.extraCount, now = this.now();
      // 插入在文档提交之前；重试使用入站中冻结的全部键，避免崩溃后扩大原合并批次。
      const rec = this.opts.inbox.insert({ key, owner: this.opts.owner, source: id, count: events.length + extraCount,
        eventKeys, text: renderEventInput(id, events, extraCount, now), time: Math.floor(now / 1000) });
      const frozenKeys = rec.event_keys ?? eventKeys;
      const frozenEvents = state.held.filter(event => frozenKeys.includes(eventInputKey(id, event.externalId))).slice(0, 10);
      const run: EventRun = { source: id, eventKeys: frozenKeys, events: frozenEvents, deliveredAt: rec.time * 1000,
        extraCount: Math.max(0, (rec.event_count ?? events.length) - frozenEvents.length) };
      state.held = state.held.filter(event => !frozenKeys.includes(eventInputKey(id, event.externalId)));
      state.extraKeys = state.extraKeys.filter(key => !frozenKeys.includes(key)); state.extraCount = state.extraKeys.length;
      state.stats.deliveredInHour++; this.count(state, "delivered");
      if (!state.held.length) {
        delete state.mergeAt;
        if (state.pendingCursor !== undefined) { state.cursor = state.pendingCursor; delete state.pendingCursor; }
      }
      await this.opts.harness.commit(async tx => {
        const doc = await tx.doc(EventsDoc), stored = await tx.doc(EventRunDoc, key, {});
        if (!stored.source) Object.assign(stored, run);
        if (!doc.runs.includes(key)) doc.runs.push(key);
        while (doc.runs.length > 200) await tx.retireDoc(EventRunDoc, doc.runs.shift()!);
        doc.sources[id] = state;
      }, ctx);
      await this.opts.inbox.deliver(key);
      this.event("event_received", { source: id, kind: head.kind, decision: "delivered", key });
      const outcome = await this.opts.inputOutcome?.(key);
      if (outcome) await this.finishState(key, outcome);
      state = await this.state(id);
      if (!this.enabled(state)) return;
    }
  }
  private async backendReady(id: string, state: EventSourceState): Promise<boolean> {
    const backend = await this.opts.ownerBackend();
    if (backend === "pi") {
      if (state.stats.blockedReason) {
        delete state.stats.blockedReason;
        state.stats.degraded = state.stats.consecutivePollFailures >= 3;
        await this.save(id, state);
        this.event("event_source_state", { source: id, state: "enabled", reason: "backend_supported" });
      }
      return true;
    }
    if (!state.held.length) return false;
    const reason = backend === "codex" ? "owner 线程后端为 codex，事件需要 Pi 后端" : "owner 线程尚未选定 Pi 后端，事件等待会话初始化";
    if (state.stats.blockedReason !== reason) this.event("event_source_state", { source: id, state: "blocked", reason: "backend_unsupported" });
    state.stats.blockedReason = reason; state.stats.degraded = true;
    await this.save(id, state);
    this.event("event_received", { source: id, decision: "backend_unsupported", events: state.held.length });
    this.defer(id, 30_000);
    return false;
  }
  async delivered(key: string, turnId: string): Promise<void> {
    const run = await this.opts.harness.snapshot(EventRunDoc, key, ctx);
    if (!run?.source) return;
    await this.serial(run.source, () => this.opts.harness.commit(async tx => {
      const run = await tx.doc(EventRunDoc, key, {}); run.turnId ??= turnId;
    }, ctx));
  }
  async finish(key: string, outcome: Outcome): Promise<void> {
    const run = await this.opts.harness.snapshot(EventRunDoc, key, ctx);
    if (run?.source) await this.serial(run.source, () => this.finishState(key, outcome));
  }
  private async finishState(key: string, outcome: Outcome) {
    const run = await this.opts.harness.snapshot(EventRunDoc, key, ctx);
    if (!run?.source || run.result) return;
    const turnId = outcome.turnId ?? run.turnId;
    const result = turnResult(outcome.status, turnId ? this.opts.outbox?.(turnId) ?? [] : []);
    const state = await this.state(run.source); this.count(state, result.status);
    state.stats.consecutiveTurnFailures = result.status === "failed" ? state.stats.consecutiveTurnFailures + 1 : 0;
    const pause = state.stats.consecutiveTurnFailures >= 3 && !state.stats.pausedReason;
    if (pause) { state.enabled = false; state.stats.pausedReason = "连续 3 次失败"; }
    await this.opts.harness.commit(async tx => {
      const record = await tx.doc(EventRunDoc, key, {});
      record.result = { status: result.status, at: this.now() };
      if (turnId) record.turnId = turnId;
      (await tx.doc(EventsDoc)).sources[run.source] = state;
    }, ctx);
    this.event("event_turn", { source: run.source, key, events: run.events.length + run.extraCount, result: result.status, durationMs: this.now() - run.deliveredAt });
    if (pause) {
      clearTimeout(this.pollTimers.get(run.source)); clearTimeout(this.flushTimers.get(run.source));
      this.controllers.get(run.source)?.abort();
      this.event("event_source_state", { source: run.source, state: "paused", reason: "连续 3 次失败" });
    }
  }
}

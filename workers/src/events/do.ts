import { DurableObject } from "cloudflare:workers";
import { GitHubConnections } from "../github/connections";
import { GitHubInbox } from "../github/inbox";
import { DEFAULT_GITHUB, type GitHubDelivery } from "../github/model";
import type { Env } from "../env";
import { ownerIds, type InboundInput } from "../policy";
import { GmailClient, type SendRequest } from "../gmail/client";
import { errorKind, type GmailErrorKind } from "../gmail/http";
import { GmailAuth } from "../gmail/oauth";
import { DEFAULT_SETTINGS, eventKey, normalizeEvent, parseSettings, quietRemaining, renderEventInput, suppressed,
  type EventRunStatus, type EventSource, type ExternalEvent, type HeldReason, type SourceSettings } from "./model";

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const SEEN_RETENTION = 30 * DAY, RECEIPT_RETENTION = 7 * DAY, HELD_LIMIT = 200, BATCH = 10, PAGES = 5, POLL_LIMIT = 50;
// Gmail watch 七天过期，提前一天续期即每六天一次。
const WATCH_RENEW_BEFORE = DAY;
const RECONCILE_AFTER = 15 * MINUTE;

type SourceRow = {
  id: string; enabled: number; cursor: string | null; failures: number; degraded: number; paused: number;
  pause_reason: string | null; settings_json: string; last_poll_at: number | null; last_error_code: string | null;
};
type HeldRow = { key: string; source: string; event_json: string; received_at: number; reason: HeldReason; input_key: string | null };
type RunRow = { input_key: string; source: string; keys_json: string; delivered_at: number; status: EventRunStatus; ended_at: number | null };
export type GmailResult = { ok: true; text: string } | { ok: false; error: GmailErrorKind };
type GmailSendRequest = SendRequest & { idempotencyKey: string };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS event_seen (key TEXT PRIMARY KEY, source TEXT NOT NULL, delivered_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS event_held (key TEXT PRIMARY KEY, source TEXT NOT NULL, event_json TEXT NOT NULL, received_at INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('merge', 'quiet', 'budget')), input_key TEXT);
CREATE INDEX IF NOT EXISTS event_held_input ON event_held(input_key);
CREATE TABLE IF NOT EXISTS event_source (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, cursor TEXT, failures INTEGER NOT NULL DEFAULT 0,
  degraded INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0, pause_reason TEXT, settings_json TEXT NOT NULL,
  last_poll_at INTEGER, last_error_code TEXT);
CREATE TABLE IF NOT EXISTS event_run (input_key TEXT PRIMARY KEY, source TEXT NOT NULL, keys_json TEXT NOT NULL, delivered_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'silent', 'failed')), ended_at INTEGER);
CREATE INDEX IF NOT EXISTS event_run_source ON event_run(source, delivered_at);
CREATE TABLE IF NOT EXISTS gmail_auth (id TEXT PRIMARY KEY, access_token_enc TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS gmail_watch (id TEXT PRIMARY KEY, history_id TEXT NOT NULL, expiration INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS gmail_send_receipts (key TEXT PRIMARY KEY, message_id TEXT NOT NULL, sent_at INTEGER NOT NULL);
`;

/**
 * 外部事件服务与 Gmail 的唯一宿主：去重 → 过滤 → 合并窗口 → 安静时段 → 每小时预算 → 投递 owner 线程。
 * event_held 行在投递时先挂上 input_key，ThreadDO 确认入站后才删除，因此崩溃只会重投同一批，不会丢件。
 */
export class EventsDO extends DurableObject<Env> {
  private readonly sql = this.ctx.storage.sql;
  private readonly github: GitHubInbox;
  private readonly githubConnections: GitHubConnections;
  private readonly auth: GmailAuth;
  private readonly gmail: GmailClient;
  private readonly sources: ReadonlyMap<string, EventSource>;
  private readonly polls = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private readonly sends = new Map<string, Promise<GmailResult>>();
  private flushing: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(SCHEMA);
    this.githubConnections = new GitHubConnections(this.ctx.storage,env, () => this.github.reauthorize());
    this.github = new GitHubInbox(this.ctx.storage,{
      authorized:(installationId,repositoryId)=>this.githubConnections.authorized(installationId,repositoryId),
      related:delivery=>this.githubConnections.related(delivery),
      lifecycle:delivery=>this.githubConnections.lifecycle(delivery),
    });
    this.auth = new GmailAuth(this.sql, env);
    this.gmail = new GmailClient(this.auth);
    this.sources = new Map<string, EventSource>([["gmail", { id: "gmail", configured: () => this.auth.configured(), poll: (cursor, limit, signal) => this.gmail.events(cursor, limit, signal) }], ["github", { id: "github", configured: () => this.githubConnections.configured() }]]);
    for (const id of this.sources.keys()) this.sql.exec("INSERT OR IGNORE INTO event_source (id, settings_json) VALUES (?, ?)", id, JSON.stringify(id === 'github' ? DEFAULT_GITHUB.settings : DEFAULT_SETTINGS));
  }

  githubConnectionsView() { return this.githubConnections.snapshot(); }
  startGitHubConnect(admin:string,browser:string) { return this.githubConnections.start(admin,browser); }
  completeGitHubConnect(state:string,code:string,admin:string,browser:string) { return this.githubConnections.complete(state,code,admin,browser); }
  async syncGitHubConnect(userId?:number) { await this.githubConnections.sync(userId,true); return this.githubConnections.snapshot(); }
  disconnectGitHubConnect(kind:"user"|"installation",id:number) {
    if(kind==="user") this.githubConnections.disconnectUser(id); else this.githubConnections.disconnectInstallation(id);
    return this.githubConnections.snapshot();
  }

  async receiveGitHub(delivery: GitHubDelivery) {
    if (!this.githubConnections.configured()) return {status:503,code:"unconfigured"};
    const result = this.github.receive(delivery);
    // Only newly admitted held business needs a wake; diagnostics/replays must not amplify alarms.
    // Cron recovers committed held rows if a crash or failed alarm occurs before ACK.
    if (result.code === "received") {
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm === null || alarm > Date.now() + 1000) await this.ctx.storage.setAlarm(Date.now() + 1000);
    }
    await this.ctx.storage.sync();
    return result;
  }

  async putGitHubConfig(value: unknown, expectedRevision: string) {
    const wasPaused = !!this.source("github")?.paused;
    const result = this.github.put(value, expectedRevision);
    if (result.ok && wasPaused && !result.current.value.paused) await this.ctx.storage.put("resumed:github", Date.now());
    if (result.ok) {
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      // An input paused after Thread enqueue has no held row. Wake its durable pump on edits/resume.
      const keys = this.sql.exec<{ input_key: string }>("SELECT DISTINCT input_key FROM github_receipt WHERE input_key IS NOT NULL AND state IN ('enqueued','suppressed') AND EXISTS (SELECT 1 FROM event_run r WHERE r.input_key=github_receipt.input_key AND r.status='queued') LIMIT 200").toArray();
      this.ctx.waitUntil(Promise.all(keys.map(row => this.env.THREAD.getByName("owner").eventOutcome(row.input_key))).catch(() => {
        console.error({ event: "github_resume_wake_failed" });
      }));
    }
    return result;
  }

  githubReceipt(id: string) { return this.github.receipt(id); }

  claimGitHubRun(key: string) { return this.github.claim(key); }

  private source(id: string): SourceRow | undefined {
    return this.sql.exec<SourceRow>("SELECT * FROM event_source WHERE id = ?", id).toArray()[0];
  }
  private settings(row: SourceRow): SourceSettings {
    let value: unknown;
    try { value = JSON.parse(row.settings_json); } catch { value = undefined; }
    return parseSettings(value) ?? (row.id === "github" ? DEFAULT_GITHUB.settings : DEFAULT_SETTINGS);
  }

  /** 定时与推送共用；同一来源单飞，推送在拉取进行中到达时再拉一轮，避免漏掉刚写入的 history。 */
  async poll(id: string, force = false): Promise<void> {
    const running = this.polls.get(id);
    if (running) { if (force) this.again.add(id); return running; }
    const task = (async () => {
      let first = true;
      while (first || this.again.has(id)) {
        this.again.delete(id);
        await this.pollOnce(id, force || !first);
        first = false;
      }
      if (id === "gmail") await this.renewWatch();
      await this.flush();
    })().finally(() => { this.polls.delete(id); });
    this.polls.set(id, task);
    return task;
  }

  async notify(id: string): Promise<void> {
    await this.poll(id, true);
  }

  private async pollOnce(id: string, force: boolean): Promise<void> {
    const source = this.sources.get(id), row = this.source(id);
    if (!source?.poll || !row || !row.enabled || row.paused) return;
    if (!source.configured()) {
      this.sql.exec("UPDATE event_source SET last_error_code = 'unconfigured' WHERE id = ?", id);
      return;
    }
    // Cron 每 5 分钟触发，留出几秒抖动余量，intervalS 才能按设定生效。
    if (!force && row.last_poll_at !== null && Date.now() - row.last_poll_at < this.settings(row).intervalS * 1000 - 5000) return;
    let cursor = row.cursor, fetched = 0;
    try {
      for (let page = 0; page < PAGES; page++) {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30_000);
        try {
          const result = await source.poll(cursor, POLL_LIMIT, controller.signal);
          fetched += result.events.length;
          await this.accept(id, result.events, result.cursor);
          cursor = result.cursor;
          if (!result.more) break;
        } finally { clearTimeout(timer); }
      }
      this.sql.exec("UPDATE event_source SET failures = 0, degraded = 0, last_poll_at = ?, last_error_code = NULL WHERE id = ?", Date.now(), id);
      console.log({ event: "event_poll", source: id, status: "ok", fetched });
    } catch (error) {
      const code = errorKind(error), failures = row.failures + 1;
      this.sql.exec("UPDATE event_source SET failures = ?, degraded = ?, last_poll_at = ?, last_error_code = ? WHERE id = ?",
        failures, failures >= 3 ? 1 : row.degraded, Date.now(), code, id);
      console.log({ event: "event_poll", source: id, status: "failed", code });
      if (failures === 3) await this.alert(`poll:${id}`, `外部事件来源 ${id} 连续 3 次拉取失败（${code}），已标记降级，仍会继续重试。`);
    }
  }

  private async accept(id: string, values: readonly unknown[], cursor: string): Promise<void> {
    const row = this.source(id);
    if (!row) return;
    const settings = this.settings(row), now = Date.now();
    const prepared: { key: string; event: ExternalEvent }[] = [];
    for (const value of values) {
      const event = normalizeEvent(value);
      if (event?.source === id) prepared.push({ key: await eventKey(id, event.externalId), event });
    }
    let held = 0, deduped = 0, filtered = 0, dropped = 0;
    // 积压与游标同一事务提交：游标前进时事件已持久在 event_held。
    this.ctx.storage.transactionSync(() => {
      for (const { key, event } of prepared) {
        if (this.sql.exec("SELECT 1 FROM event_seen WHERE key = ? UNION ALL SELECT 1 FROM event_held WHERE key = ?", key, key).toArray().length) { deduped++; continue; }
        if (suppressed(settings, event)) { filtered++; continue; }
        this.sql.exec("INSERT INTO event_held (key, source, event_json, received_at, reason) VALUES (?, ?, ?, ?, 'merge')", key, id, JSON.stringify(event), now);
        held++;
      }
      dropped = this.sql.exec("DELETE FROM event_held WHERE key IN (SELECT key FROM event_held WHERE source = ? AND input_key IS NULL ORDER BY received_at, rowid LIMIT max(0, (SELECT COUNT(*) FROM event_held WHERE source = ?) - ?))",
        id, id, HELD_LIMIT).rowsWritten;
      this.sql.exec("UPDATE event_source SET cursor = ? WHERE id = ?", cursor, id);
    });
    if (prepared.length || values.length) console.log({ event: "event_received", source: id, held, deduped, suppressed: filtered, rejected: values.length - prepared.length, dropped });
    if (dropped) await this.alert(`held:${id}`, `外部事件来源 ${id} 积压超过 ${HELD_LIMIT} 件，已丢弃最旧的 ${dropped} 件。`);
  }

  private flush(): Promise<void> {
    const run = this.flushing.then(() => this.flushNow());
    this.flushing = run.catch(() => {});
    return run;
  }

  private async flushNow(): Promise<void> {
    const now = Date.now();
    this.github.prune();
    this.sql.exec("DELETE FROM event_seen WHERE delivered_at < ?", now - SEEN_RETENTION);
    this.sql.exec("DELETE FROM event_run WHERE delivered_at < ? AND status != 'queued'", now - SEEN_RETENTION);
    this.sql.exec("DELETE FROM gmail_send_receipts WHERE sent_at < ?", now - RECEIPT_RETENTION);
    for (const id of this.sources.keys()) await this.flushSource(id, now);
    await this.reconcile(now);
    await this.schedule();
  }

  private async flushSource(id: string, now: number): Promise<void> {
    if (id === 'github') this.github.reauthorize();
    for (const { input_key } of this.sql.exec<{ input_key: string }>("SELECT DISTINCT input_key FROM event_held WHERE source = ? AND input_key IS NOT NULL", id).toArray()) {
      await this.deliver(id, input_key);
    }
    const row = this.source(id);
    if (!row || !row.enabled || row.paused) return;
    const settings = this.settings(row);
    if (id === "github") this.sql.exec("UPDATE event_held SET reason='merge' WHERE source='github' AND input_key IS NULL AND reason='budget'");
    const held = this.sql.exec<HeldRow>("SELECT * FROM event_held WHERE source = ? AND input_key IS NULL ORDER BY received_at, rowid", id).toArray();
    const pending = held.filter(item => item.reason !== "budget");
    let extras = held.filter(item => item.reason === "budget");
    const first = pending[0];
    if (!first) return;
    if (quietRemaining(settings.quietHours, now) > 0) {
      this.sql.exec("UPDATE event_held SET reason = 'quiet' WHERE source = ? AND input_key IS NULL AND reason = 'merge'", id);
      return;
    }
    if (first.received_at + settings.mergeWindowS * 1000 > now) return;
    while (pending.length) {
      const used = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM event_run WHERE source = ? AND delivered_at > ?", id, now - HOUR).one().n;
      if (used >= settings.budgetPerHour) {
        // 超额不丢：挂到下一条输入末尾，只计数不展开。
        for (const item of pending) this.sql.exec("UPDATE event_held SET reason = 'budget' WHERE key = ?", item.key);
        return;
      }
      const batch = pending.splice(0, BATCH), inputKey = batch[0]!.key, keys = [...batch, ...extras].map(item => item.key);
      extras = [];
      this.ctx.storage.transactionSync(() => {
        if (id === "github") this.github.enqueued(keys, inputKey);
        this.sql.exec("INSERT INTO event_run (input_key, source, keys_json, delivered_at, status) VALUES (?, ?, ?, ?, 'queued')", inputKey, id, JSON.stringify(keys), now);
        for (const key of keys) {
          this.sql.exec("INSERT OR IGNORE INTO event_seen (key, source, delivered_at) VALUES (?, ?, ?)", key, id, now);
          this.sql.exec("UPDATE event_held SET input_key = ? WHERE key = ?", inputKey, key);
        }
      });
      await this.deliver(id, inputKey);
      // Re-read policy/held rows on the next alarm, not a stale batch after an RPC yield.
      if (id === "github") return;
    }
  }

  private async deliver(id: string, inputKey: string): Promise<void> {
    const rows = this.sql.exec<HeldRow>("SELECT * FROM event_held WHERE input_key = ? ORDER BY received_at, rowid", inputKey).toArray();
    const run = this.sql.exec<RunRow>("SELECT * FROM event_run WHERE input_key = ?", inputKey).toArray()[0];
    const owner = ownerIds(this.env)[0];
    if (!rows.length || !run || !owner) return;
    const events = rows.filter(item => item.reason !== "budget").map(item => JSON.parse(item.event_json) as ExternalEvent);
    const selfId = (await this.env.BRIDGE.getByName("napcat").status().catch(() => undefined))?.selfId ?? "";
    const text = renderEventInput(id, events, rows.length - events.length, run.delivered_at);
    const input: InboundInput = { kind: "event", messageId: inputKey, selfId, userId: owner, nickname: "", target: { kind: "private", userId: owner },
      text, routeText: "", time: Math.floor(run.delivered_at / 1000), mentionedSelf: false, replyToId: null, imageCount: 0 };
    try { await this.env.THREAD.getByName("owner").deliverEvent(input); }
    catch {
      console.error({ event: "event_delivery_failed", source: id, key: inputKey });
      return;
    }
    this.sql.exec("DELETE FROM event_held WHERE input_key = ?", inputKey);
    console.log({ event: "event_delivered", source: id, key: inputKey, events: events.length, extra: rows.length - events.length });
  }

  /** ThreadDO 在事件回合结算后回报；sent / silent 看本回合是否发出消息。 */
  async finishRun(key: string, status: EventRunStatus): Promise<void> {
    if (status === "queued") return;
    if (key.startsWith("evt_github_")) this.github.finish(key, status);
    const run = this.sql.exec<{ source: string }>("UPDATE event_run SET status = ?, ended_at = ? WHERE input_key = ? AND status = 'queued' RETURNING source", status, Date.now(), key).toArray()[0];
    console.log({ event: "event_turn", key, result: status });
    if (!run || status !== "failed") return;
    // 只数恢复之后结束的回合，恢复后的第一次失败不会立刻再次暂停。
    const since = await this.ctx.storage.get<number>(`resumed:${run.source}`) ?? 0;
    const recent = this.sql.exec<{ status: string }>("SELECT status FROM event_run WHERE source = ? AND status != 'queued' AND ended_at > ? ORDER BY ended_at DESC, rowid DESC LIMIT 3", run.source, since).toArray();
    if (recent.length < 3 || recent.some(item => item.status !== "failed")) return;
    if (this.sql.exec("UPDATE event_source SET paused = 1, pause_reason = 'turn_failures' WHERE id = ? AND paused = 0", run.source).rowsWritten) {
      if (run.source === "github") { const current = this.github.snapshot(); this.github.put({ ...current.value, paused: true }, current.revision); }
      await this.alert(`paused:${run.source}`, `外部事件来源 ${run.source} 连续 3 次事件回合失败，已暂停；修复后在管理端点恢复。`);
    }
  }

  /** 回报丢失或 ThreadDO 冷启动后无人唤醒时，按入站键向 ThreadDO 对账。 */
  private async reconcile(now: number): Promise<void> {
    const stale = this.sql.exec<RunRow>(`SELECT * FROM event_run r WHERE status = 'queued' AND delivered_at < ?
      AND NOT EXISTS (SELECT 1 FROM event_held h WHERE h.input_key = r.input_key) ORDER BY delivered_at LIMIT 20`, now - RECONCILE_AFTER).toArray();
    for (const run of stale) {
      let outcome: EventRunStatus | undefined;
      try { outcome = await this.env.THREAD.getByName("owner").eventOutcome(run.input_key); }
      catch { continue; }
      // 入站确认之后才删除积压，ThreadDO 不认识这条输入说明它已无法完成，按失败结账。
      await this.finishRun(run.input_key, outcome ?? "failed");
    }
  }

  private async schedule(): Promise<void> {
    const now = Date.now(), times: number[] = [];
    for (const id of this.sources.keys()) {
      const row = this.source(id);
      if (!row || !row.enabled || row.paused) continue;
      const settings = this.settings(row);
      const first = this.sql.exec<HeldRow>("SELECT * FROM event_held WHERE source = ? AND input_key IS NULL AND (reason != 'budget' OR source='github') ORDER BY received_at, rowid LIMIT 1", id).toArray()[0];
      if (first) {
        const quiet = quietRemaining(settings.quietHours, now);
        let due = quiet > 0 ? now + quiet : first.received_at + settings.mergeWindowS * 1000;
        if (id === "github" && this.budgetUsed(id) >= settings.budgetPerHour) {
          const oldest = this.sql.exec<{ at: number }>("SELECT MIN(delivered_at) AS at FROM event_run WHERE source='github' AND delivered_at > ?", now - HOUR).one();
          due = Math.max(due, oldest.at + HOUR + 1);
        }
        times.push(due);
      }
    }
    if (this.sql.exec("SELECT 1 FROM event_held WHERE input_key IS NOT NULL LIMIT 1").toArray().length) times.push(now + MINUTE);
    const watch = this.watchTopic() ? this.sql.exec<{ expiration: number }>("SELECT expiration FROM gmail_watch WHERE id = 'owner'").toArray()[0] : undefined;
    if (watch) times.push(watch.expiration - WATCH_RENEW_BEFORE);
    if (times.length) await this.ctx.storage.setAlarm(Math.max(now + 1000, Math.min(...times)));
    else await this.ctx.storage.deleteAlarm();
  }

  override async alarm(): Promise<void> {
    await this.renewWatch();
    await this.flush();
  }

  /** Cron 入口：间隔未到的来源跳过拉取，但仍检查 watch 续期、合并到期与对账。 */
  async tick(): Promise<void> {
    if (this.githubConnections.configured()) this.ctx.waitUntil(this.githubConnections.sync().catch(() => { console.error({event:"github_sync_failed"}); }));
    for (const id of this.sources.keys()) await this.poll(id);
  }

  private watchTopic(): string | undefined {
    const topic = this.env.GMAIL_PUBSUB_TOPIC?.trim();
    return topic && /^projects\/[a-z][a-z0-9-]{4,61}[a-z0-9]\/topics\/[A-Za-z][\w.~+%-]{2,254}$/.test(topic) && this.auth.configured() ? topic : undefined;
  }

  private async renewWatch(): Promise<void> {
    const topic = this.watchTopic();
    if (!topic) return;
    const row = this.sql.exec<{ expiration: number }>("SELECT expiration FROM gmail_watch WHERE id = 'owner'").toArray()[0];
    if (row && row.expiration - Date.now() > WATCH_RENEW_BEFORE) return;
    try {
      const result = await this.gmail.watch(topic);
      this.sql.exec("INSERT OR REPLACE INTO gmail_watch (id, history_id, expiration) VALUES ('owner', ?, ?)", result.historyId, Number(result.expiration));
    } catch (error) {
      console.error({ event: "gmail_watch_failed", code: errorKind(error) });
    }
  }

  private async alert(reason: string, text: string): Promise<void> {
    const owner = ownerIds(this.env)[0];
    if (!owner) return;
    const key = `alert:${reason}`, last = await this.ctx.storage.get<number>(key);
    if (last !== undefined && Date.now() - last < HOUR) return;
    await this.ctx.storage.put(key, Date.now());
    // 发送可能等 OneBot 回执十几秒，告警不能阻塞拉取与投递。
    this.ctx.waitUntil(this.env.BRIDGE.getByName("napcat").sendPrivate(owner, text).then(() => {}, () => {
      console.error({ event: "event_alert_failed", reason });
    }));
  }

  private async gmailCall(work: () => Promise<string>): Promise<GmailResult> {
    try { return { ok: true, text: await work() }; }
    catch (error) { return { ok: false, error: errorKind(error) }; }
  }
  gmailSearch(query: string, maxResults: number): Promise<GmailResult> {
    return this.gmailCall(() => this.gmail.search(query, Math.max(1, Math.min(20, Math.floor(maxResults)))));
  }
  gmailRead(id: string): Promise<GmailResult> {
    return this.gmailCall(() => this.gmail.read(id));
  }
  /** 回执表按调用方给的幂等键记账；同键并发共享同一次发送。发送成功后、写回执前崩溃仍可能重发。 */
  gmailSend(request: GmailSendRequest): Promise<GmailResult> {
    const existing = this.sends.get(request.idempotencyKey);
    if (existing) return existing;
    const run = this.gmailCall(async () => {
      const receipt = this.sql.exec<{ message_id: string }>("SELECT message_id FROM gmail_send_receipts WHERE key = ?", request.idempotencyKey).toArray()[0];
      if (receipt) return `已发送 messageId=${receipt.message_id}（同一 idempotencyKey 的重复调用，未再次发送）`;
      const { idempotencyKey, ...mail } = request;
      const sent = await this.gmail.send(mail);
      this.sql.exec("INSERT INTO gmail_send_receipts (key, message_id, sent_at) VALUES (?, ?, ?)", idempotencyKey, sent.id, Date.now());
      return `已发送 messageId=${sent.id} threadId=${sent.threadId}`;
    }).finally(() => { this.sends.delete(request.idempotencyKey); });
    this.sends.set(request.idempotencyKey, run);
    return run;
  }

  private budgetUsed(id: string): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM event_run WHERE source = ? AND delivered_at > ?", id, Date.now() - HOUR).one().n;
  }
  private heldCount(id?: string): number {
    return id === undefined ? this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM event_held").one().n
      : this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM event_held WHERE source = ?", id).one().n;
  }

  health() {
    const sources = [...this.sources.values()].map(source => {
      const row = this.source(source.id);
      return { id: source.id, enabled: !!row?.enabled && source.configured(), paused: !!row?.paused, degraded: !!row?.degraded,
        cursor: !!row?.cursor, lastPollAt: row?.last_poll_at ?? null };
    });
    return { sources, held: this.heldCount() };
  }

  adminStatus() {
    const sources = [...this.sources.values()].map(source => {
      const row = this.source(source.id);
      const settings = row ? this.settings(row) : DEFAULT_SETTINGS;
      return { id: source.id, configured: source.configured(), enabled: !!row?.enabled, paused: !!row?.paused, pauseReason: row?.pause_reason ?? null,
        degraded: !!row?.degraded, failures: row?.failures ?? 0, cursor: row?.cursor ?? null, lastPollAt: row?.last_poll_at ?? null,
        lastErrorCode: row?.last_error_code ?? null, held: this.heldCount(source.id),
        budget: { used: this.budgetUsed(source.id), perHour: settings.budgetPerHour }, settings };
    });
    const runs = this.sql.exec<RunRow>("SELECT * FROM event_run ORDER BY delivered_at DESC, rowid DESC LIMIT 20").toArray().map(run => ({
      key: run.input_key, source: run.source, events: (JSON.parse(run.keys_json) as unknown[]).length,
      deliveredAt: run.delivered_at, status: run.status, endedAt: run.ended_at }));
    const watch = this.sql.exec<{ expiration: number }>("SELECT expiration FROM gmail_watch WHERE id = 'owner'").toArray()[0];
    return { sources, runs, github: { ...this.github.status(), connections: this.githubConnections.snapshot(), configured: this.githubConnections.configured() }, watch: { topic: !!this.watchTopic(), expiration: watch?.expiration ?? null } };
  }

  async setPaused(id: string, paused: boolean): Promise<boolean> {
    if (!this.sources.has(id) || id === "github") return false;
    this.sql.exec("UPDATE event_source SET paused = ?, pause_reason = ? WHERE id = ?", paused ? 1 : 0, paused ? "manual" : null, id);
    if (!paused) {
      await this.ctx.storage.put(`resumed:${id}`, Date.now());
      await this.flush();
    }
    return true;
  }

  async putSettings(id: string, value: unknown): Promise<"ok" | "unknown_source" | "invalid"> {
    if (!this.sources.has(id) || id === "github") return "unknown_source";
    const settings = parseSettings(value);
    if (!settings) return "invalid";
    this.sql.exec("UPDATE event_source SET settings_json = ? WHERE id = ?", JSON.stringify(settings), id);
    await this.flush();
    return "ok";
  }
}

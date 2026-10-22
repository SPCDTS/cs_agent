/**
 * bridge 出站发送规则（设计 docs/ARCHITECTURE.md §3.3）：每会话每分钟限额、每会话每小时熔断、全局每分钟熔断。
 * 计数与熔断状态存于 qq-bridge.sqlite，重启后仍然有效；只记录真正被接纳发送的消息，被拒的尝试不计数。
 * 检查与记数须在调用方的同一个写事务里完成（ReplyStore 负责事务），并发发送不会同时越过限额。
 * owner 告警（sendOps）与熔断通知本身不经过这里。
 */
import type { DatabaseSync } from "node:sqlite";
import { GLOBAL_SEND_SCOPE, SendRuleError, type SendBreaker, type SendRuleLimits } from "../channel/send-rules.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * send_log：每条被接纳的发送一行，只保留最近一小时。
 * send_breakers：每个 scope 一行，until 之前处于熔断；since 之前的发送不再计入该 scope 的窗口
 * （熔断到期或手动解除后从零开始计数，避免解除后立即再次熔断）。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS send_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, scope TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS send_log_scope_ts ON send_log(scope, ts);
CREATE INDEX IF NOT EXISTS send_log_ts ON send_log(ts);
CREATE TABLE IF NOT EXISTS send_breakers (
  scope TEXT PRIMARY KEY, until INTEGER NOT NULL, since INTEGER NOT NULL, tripped_at INTEGER NOT NULL, reason TEXT NOT NULL
);
`;

const minutesLeft = (ms: number) => Math.max(1, Math.ceil(ms / MINUTE_MS));

export class SendRules {
  constructor(private readonly db: DatabaseSync) { db.exec(SCHEMA); }

  /** 被拒时抛 SendRuleError；刚触发的熔断已写入，调用方须提交事务。通过时不记数，接纳后由 record 记入。 */
  check(scope: string, limits: SendRuleLimits, now: number): void {
    for (const breaker of this.openBreakers(now, [GLOBAL_SEND_SCOPE, scope])) {
      const global = breaker.scope === GLOBAL_SEND_SCOPE;
      throw new SendRuleError(`${global ? "全部会话" : "本会话"}发送已熔断（${breaker.reason}），约 ${minutesLeft(breaker.until - now)} 分钟后恢复，请不要再发`,
        "breaker", breaker.scope);
    }
    const globalCount = this.count(null, now - MINUTE_MS, this.since(GLOBAL_SEND_SCOPE));
    if (globalCount >= limits.globalMinute) {
      const tripped = this.trip(GLOBAL_SEND_SCOPE, `全局每分钟超过 ${limits.globalMinute} 条`, limits.globalBreakerMinutes, now);
      throw new SendRuleError(`全局发送过多：每分钟最多 ${limits.globalMinute} 条，已暂停全部发送 ${limits.globalBreakerMinutes} 分钟`,
        "global_minute", GLOBAL_SEND_SCOPE, tripped);
    }
    const since = this.since(scope);
    if (this.count(scope, now - HOUR_MS, since) >= limits.perChatHour) {
      const tripped = this.trip(scope, `每小时超过 ${limits.perChatHour} 条`, limits.chatBreakerMinutes, now);
      throw new SendRuleError(`发送过多：本会话每小时最多 ${limits.perChatHour} 条，已暂停本会话发送 ${limits.chatBreakerMinutes} 分钟`,
        "chat_hour", scope, tripped);
    }
    if (this.count(scope, now - MINUTE_MS, since) >= limits.perChatMinute) {
      throw new SendRuleError(`发送过快：本会话每分钟最多 ${limits.perChatMinute} 条，请稍后再发`, "chat_minute", scope);
    }
  }

  record(scope: string, now: number): void {
    this.db.prepare("INSERT INTO send_log (ts, scope) VALUES (?, ?)").run(now, scope);
    this.db.prepare("DELETE FROM send_log WHERE ts < ?").run(now - HOUR_MS);
  }

  breakers(now: number): SendBreaker[] { return this.openBreakers(now); }

  /** 手动解除：立即结束熔断，并从此刻重新计数。返回 false 表示该 scope 没有处于熔断。 */
  reset(scope: string, now: number): boolean {
    return Number(this.db.prepare("UPDATE send_breakers SET until = ?, since = ? WHERE scope = ? AND until > ?")
      .run(now, now, scope, now).changes) === 1;
  }

  private openBreakers(now: number, scopes?: string[]): SendBreaker[] {
    const rows = this.db.prepare("SELECT scope, until, tripped_at, reason FROM send_breakers WHERE until > ? ORDER BY scope = ? DESC, until")
      .all(now, GLOBAL_SEND_SCOPE) as unknown as SendBreaker[];
    return rows.map(row => ({ scope: row.scope, until: Number(row.until), tripped_at: Number(row.tripped_at), reason: row.reason }))
      .filter(row => !scopes || scopes.includes(row.scope));
  }

  private since(scope: string): number {
    const row = this.db.prepare("SELECT since FROM send_breakers WHERE scope = ?").get(scope) as { since: number } | undefined;
    return row ? Number(row.since) : 0;
  }

  /** 统计 (max(from, since), now] 内的发送；scope 为 null 时统计全部会话。since 本身不计（解除时刻同一毫秒的旧发送不算）。 */
  private count(scope: string | null, from: number, since: number): number {
    const start = Math.max(from, since);
    const row = (scope === null
      ? this.db.prepare("SELECT count(*) AS n FROM send_log WHERE ts > ?").get(start)
      : this.db.prepare("SELECT count(*) AS n FROM send_log WHERE scope = ? AND ts > ?").get(scope, start)) as { n: number };
    return Number(row.n);
  }

  private trip(scope: string, reason: string, minutes: number, now: number): SendBreaker {
    const until = now + minutes * MINUTE_MS;
    this.db.prepare(`INSERT INTO send_breakers (scope, until, since, tripped_at, reason) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET until = excluded.until, since = excluded.since, tripped_at = excluded.tripped_at, reason = excluded.reason`)
      .run(scope, until, until, now, reason);
    return { scope, until, tripped_at: now, reason };
  }
}

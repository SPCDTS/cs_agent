export type SendBreaker = { scope: string; until: number; tripped_at: number; reason: string };
const MINUTE = 60_000, HOUR = 60 * MINUTE;

export class SendRules {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS send_log (id INTEGER PRIMARY KEY, scope TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS send_log_scope_at ON send_log(scope, at);
      CREATE INDEX IF NOT EXISTS send_log_at ON send_log(at);
      CREATE TABLE IF NOT EXISTS send_breakers (scope TEXT PRIMARY KEY, until INTEGER NOT NULL, tripped_at INTEGER NOT NULL, reason TEXT NOT NULL);
    `);
  }

  // 同步事务内检查并占用额度，避免多个 RPC 在等待回执时同时穿过上限。
  accept(scope: string, text: string, now = Date.now()): string | undefined {
    if (text.length < 1 || text.length > 4000) return "单条文字必须为 1～4000 字符";
    return this.storage.transactionSync(() => {
      const blocked = this.breakers(now).find(item => item.scope === "global" || item.scope === scope);
      if (blocked) return `${blocked.scope === "global" ? "全部会话" : "本会话"}发送已熔断（${blocked.reason}），约 ${Math.max(1, Math.ceil((blocked.until - now) / MINUTE))} 分钟后恢复，请不要再发`;
      if (this.count(null, now - MINUTE) >= 30) {
        this.trip("global", "全局每分钟超过 30 条", now + 10 * MINUTE, now);
        return "全局发送过多：每分钟最多 30 条，已暂停全部发送 10 分钟";
      }
      if (this.count(scope, now - HOUR) >= 60) {
        this.trip(scope, "每小时超过 60 条", now + HOUR, now);
        return "发送过多：本会话每小时最多 60 条，已暂停本会话发送 60 分钟";
      }
      if (this.count(scope, now - MINUTE) >= 6) return "发送过快：本会话每分钟最多 6 条，请稍后再发";
      this.storage.sql.exec("INSERT INTO send_log (scope, at) VALUES (?, ?)", scope, now);
      this.storage.sql.exec("DELETE FROM send_log WHERE at < ?", now - HOUR);
    });
  }

  breakers(now = Date.now()): SendBreaker[] {
    return this.storage.sql.exec<SendBreaker>("SELECT scope, until, tripped_at, reason FROM send_breakers WHERE until > ? ORDER BY scope = 'global' DESC, until", now).toArray();
  }
  private count(scope: string | null, from: number): number {
    // until 保留为窗口起点；熔断到期后旧记录不能立即再次触发同一个熔断。
    const reset = this.storage.sql.exec<{ until: number }>("SELECT until FROM send_breakers WHERE scope = ?", scope ?? "global").toArray()[0]?.until ?? 0;
    const start = Math.max(from, reset);
    const rows = scope === null
      ? this.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM send_log WHERE at > ?", start)
      : this.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM send_log WHERE scope = ? AND at > ?", scope, start);
    return rows.one().n;
  }
  private trip(scope: string, reason: string, until: number, now: number): void {
    // 返回拒绝原因而非在事务里抛异常，确保新熔断不会随回滚消失。
    this.storage.sql.exec(`INSERT INTO send_breakers (scope, until, tripped_at, reason) VALUES (?, ?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET until=excluded.until, tripped_at=excluded.tripped_at, reason=excluded.reason`, scope, until, now, reason);
  }
}

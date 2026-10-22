import { usageCost } from "../shared/usage.js";
import type { ObsStore } from './store.js';
import type { ObsEvent } from '../shared/trace.js';
export type Gauge = { name: string; labels?: Record<string, string>; value: number };
type Aggregate = { count: number; success: number; durations: number[]; labels: Record<string, string> };
/** 每个 60 秒窗口独立聚合；从事件游标读取。 */
export class Metrics {
  private cursor = 0;
  private timer?: NodeJS.Timeout;
  private purgedAt = 0;
  private running?: Promise<void>;
  constructor(private store: ObsStore, private options: {
    retentionDays: number; inputPrice?: number; outputPrice?: number; gauges?: () => Promise<Gauge[]>;
    /** 与观测库每日清理同时运行；辅助文件清理失败不让观测库降级。 */
    onPurge?: (now: number) => Promise<void>;
  }) { try { this.cursor = Number((store.db.prepare("SELECT value FROM obs_state WHERE key='metrics_cursor'").get() as { value: number } | undefined)?.value ?? 0); } catch { store.degrade(); } }
  start(): void { this.timer = setInterval(() => { void this.flush().catch(() => undefined); }, 60_000); this.timer.unref(); }
  flush(now = Date.now()): Promise<void> {
    if (this.store.degraded) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.collect(now).catch(() => { this.store.degrade(); }).finally(() => { this.running = undefined; });
    return this.running;
  }
  private async collect(now: number): Promise<void> {
    const gauges: Gauge[] = await this.options.gauges?.().catch((): Gauge[] => [{ name: 'gauge_sampling_failed', value: 1 }]) ?? [];
    const aggregates = new Map<string, Aggregate>();
    const usage = { input: 0, output: 0, cost: 0 };
    let cursor = this.cursor;
    for (;;) {
      const rows = this.store.db.prepare('SELECT * FROM events WHERE id>? ORDER BY id LIMIT 1000').all(cursor) as unknown as ObsEvent[];
      for (const e of rows) {
        cursor = e.id;
        if (e.status === 'started') continue;
        const d = JSON.parse(e.detail_json);
        if (e.stage === 'model_turn' && (d.provider === 'deepseek' || (d.provider === 'magpie' && String(d.model).startsWith('deepseek/')))) {
          const converted = usageCost({input:d.input_tokens,output:d.output_tokens,cacheRead:d.cache_read_tokens,cacheWrite:d.cache_write_tokens},this.options.inputPrice,this.options.outputPrice);
          usage.input += converted.input; usage.output += converted.output; usage.cost += converted.cost;
        }
        if (!/^(tool:|backend:|model_turn$)/.test(e.stage) || e.duration_ms === null) continue;
        const labels = { stage: e.stage, backend: String(d.backend ?? ''), model: String(d.model ?? '') };
        const key = JSON.stringify(labels);
        let a = aggregates.get(key);
        if (!a) aggregates.set(key, a = { count: 0, success: 0, durations: [], labels });
        a.count++; if (e.status === 'ok') a.success++;
        // 固定内存上限；高流量窗口采用等概率 reservoir，避免只保留最后一批。
        if (a.durations.length < 10_000) a.durations.push(e.duration_ms);
        else { const i = Math.floor(Math.random() * a.count); if (i < 10_000) a.durations[i] = e.duration_ms; }
      }
      if (rows.length < 1000) break;
    }
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      for (const a of aggregates.values()) {
        a.durations.sort((a,b) => a-b);
        for (const [name, value] of Object.entries({ calls: a.count, successes: a.success, success_rate: a.success/a.count,
          duration_p50_ms: a.durations[Math.ceil(a.durations.length * .5)-1]!, duration_p95_ms: a.durations[Math.ceil(a.durations.length * .95)-1]! }))
          this.store.metric(now, name, a.labels, value);
      }
      this.store.metric(now, 'deepseek_input_tokens', {}, usage.input);
      this.store.metric(now, 'deepseek_output_tokens', {}, usage.output);
      this.store.metric(now, 'deepseek_estimated_cost', {}, usage.cost);
      for (const g of gauges) this.store.metric(now, g.name, g.labels ?? {}, g.value);
      this.store.db.prepare("INSERT INTO obs_state VALUES('metrics_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(cursor);
      this.store.db.exec('COMMIT');
      this.cursor = cursor;
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    if (now - this.purgedAt >= 86400_000) {
      this.store.purge(this.options.retentionDays, now);
      await this.options.onPurge?.(now).catch(() => undefined);
      this.purgedAt = now;
    }
  }
  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); await this.flush(); }
}

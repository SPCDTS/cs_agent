import { readFileSync, promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { trace } from "../shared/trace.js";
import { log } from "../shared/log.js";

export interface ContextUsage {
  backend: "codex" | "pi";
  key: string;
  usedTokens: number;
  cachedTokens?: number;
  windowTokens: number;
  /** Codex rollout 上报的有效窗口；缺省时回退名义窗口。 */
  effectiveWindowTokens?: number;
  compaction?: { background: number; reserve: number };
  turns: number;
  lastCompactionAt?: number;
  updatedAt: number;
  source: "turn" | "estimate" | "compact";
}

export interface ContextRequestUsage {
  ticket: string;
  seq: number;
  usedTokens: number;
  cachedTokens?: number;
  outputTokens?: number;
  windowTokens: number;
  effectiveWindowTokens?: number;
  at: number;
}

type Backend = ContextUsage["backend"];
type Capacity = Pick<ContextUsage, "windowTokens" | "compaction">;
export type ContextUsageHistory = Pick<ContextUsage, "usedTokens" | "cachedTokens" | "effectiveWindowTokens" | "turns" | "updatedAt" | "lastCompactionAt">;
const nonnegative = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

function valid(value: unknown): value is ContextUsage {
  if (!value || typeof value !== "object") return false;
  const u = value as ContextUsage;
  return (u.backend === "codex" || u.backend === "pi") && typeof u.key === "string" && !!u.key &&
    nonnegative(u.usedTokens) && nonnegative(u.windowTokens) && u.windowTokens > 0 &&
    nonnegative(u.turns) && Number.isInteger(u.turns) && nonnegative(u.updatedAt) &&
    (u.source === "turn" || u.source === "estimate" || u.source === "compact") &&
    (u.cachedTokens === undefined || nonnegative(u.cachedTokens)) &&
    (u.effectiveWindowTokens === undefined || (nonnegative(u.effectiveWindowTokens) && u.effectiveWindowTokens > 0)) &&
    (u.lastCompactionAt === undefined || nonnegative(u.lastCompactionAt)) &&
    (u.compaction === undefined || (!!u.compaction && Number.isFinite(u.compaction.background) && Number.isFinite(u.compaction.reserve)));
}

/** 上一轮输入占用，不是累计计费用量。读取返回副本，订阅者不能改写存储。 */
export class ContextUsageStore {
  private readonly records = new Map<string, ContextUsage>();
  private readonly listeners = new Set<(u: ContextUsage) => void>();
  private readonly file: string;
  private timer?: ReturnType<typeof setTimeout>;
  private writes: Promise<void> = Promise.resolve();
  private revision = 0;
  private savedRevision = 0;

  constructor(dataDir: string, private readonly debounceMs = 250) {
    this.file = path.join(dataDir, "context-usage.json");
    try {
      const doc: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("invalid context usage");
      for (const [key, value] of Object.entries(doc)) {
        if (valid(value) && key === `${value.backend}:${value.key}`) this.records.set(key, structuredClone(value));
        else log.warn("invalid context usage record ignored");
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") log.warn("context usage load failed; starting empty");
    }
  }

  /** 删除已停用线程的占用，避免面板把 shared 当作活跃会话。 */
  remove(backend: Backend, key: string): void {
    if (!this.records.delete(`${backend}:${key}`)) return;
    this.revision++;
    void this.flush().catch(() => log.warn("context usage removal persistence failed; will retry on shutdown"));
  }

  all(): ContextUsage[] { return [...this.records.values()].map(u => structuredClone(u)); }
  get(backend: Backend, key: string): ContextUsage | undefined {
    const u = this.records.get(`${backend}:${key}`);
    return u && structuredClone(u);
  }
  subscribe(fn: (u: ContextUsage) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** 启动时刷新容量；无已知回合的新线程以零占用估算。 */
  ensure(backend: Backend, key: string, capacity: Capacity, ticket = "@context"): void {
    const old = this.get(backend, key);
    if (old && old.windowTokens === capacity.windowTokens && JSON.stringify(old.compaction) === JSON.stringify(capacity.compaction)) return;
    if (old && old.windowTokens !== capacity.windowTokens) delete old.effectiveWindowTokens;
    this.update({ backend, key, usedTokens: 0, turns: 0, source: "estimate", ...old, ...capacity, updatedAt: old?.updatedAt ?? Date.now() }, ticket);
  }

  /** 每次模型请求只写事件；线程状态、订阅与持久化仍由回合完成路径维护。 */
  recordRequest(backend: Backend, key: string, req: ContextRequestUsage): void {
    trace.event(req.ticket, "model_request", { detail: {
      backend, key, ticket: req.ticket, seq: req.seq, turn: (this.get(backend, key)?.turns ?? 0) + 1,
      input: req.usedTokens, cached: req.cachedTokens, output: req.outputTokens, window: req.windowTokens,
      ...(req.effectiveWindowTokens !== undefined ? { effective_window: req.effectiveWindowTokens } : {}), at: req.at,
    } });
  }

  /** 每个完成回合只计数一次；缺少用量时保留原占用、来源和采样时间。 */
  recordTurn(backend: Backend, key: string, usage: Capacity & Partial<Pick<ContextUsage, "usedTokens" | "cachedTokens" | "effectiveWindowTokens">>, ticket = "@context"): void {
    const old = this.get(backend, key);
    const sampled = usage.usedTokens !== undefined;
    this.update({ ...old, backend, key, ...usage, usedTokens: sampled ? usage.usedTokens! : old?.usedTokens ?? 0,
      cachedTokens: sampled ? usage.cachedTokens : old?.cachedTokens, turns: (old?.turns ?? 0) + 1,
      source: sampled ? "turn" : old?.source ?? "estimate", updatedAt: sampled ? Date.now() : old?.updatedAt ?? Date.now() }, ticket);
  }

  /** 压缩采样只替换占用，保留回合数；旧缓存命中量不适用于摘要后的上下文。 */
  recordCompaction(backend: Backend, key: string, ticket = "@context",
    usage?: Pick<ContextUsage, "usedTokens"> & Partial<Pick<ContextUsage, "effectiveWindowTokens">>): void {
    const old = this.get(backend, key);
    if (old) this.update({ ...old, ...(usage ? { ...usage, cachedTokens: undefined, source: "compact" as const } : {}),
      lastCompactionAt: Date.now(), updatedAt: Date.now() }, ticket);
  }

  /** 历史快照直接恢复计数；较新的已落盘用量优先，重复启动不累计回合。 */
  backfill(backend: Backend, key: string, history: ContextUsageHistory, ticket = "@context"): boolean {
    const old = this.get(backend, key);
    if (!old) return false;
    if ((old.source === "turn" && old.updatedAt > history.updatedAt) ||
        (old.source === "compact" && old.updatedAt >= history.updatedAt)) {
      // 旧版 recordTurn 的采样时间略晚于 rollout；只补缺失窗口，不能覆盖更晚的占用与计数。
      if (old.effectiveWindowTokens !== undefined || history.effectiveWindowTokens === undefined) return false;
      const enriched = { ...old, effectiveWindowTokens: history.effectiveWindowTokens };
      if (!valid(enriched)) return false;
      this.update(enriched, ticket);
      return true;
    }
    const next = { ...old, ...history, source: "turn" as const };
    if (!valid(next)) return false;
    this.update(next, ticket);
    return true;
  }

  reset(backend: Backend, key: string, ticket = "@context"): void {
    const old = this.get(backend, key);
    if (!old) return;
    const { lastCompactionAt: _last, effectiveWindowTokens: _effective, ...capacity } = old;
    this.update({ ...capacity, usedTokens: 0, cachedTokens: 0, turns: 0, source: "estimate", updatedAt: Date.now() }, ticket);
  }

  private update(u: ContextUsage, ticket: string): void {
    if (!valid(u)) throw new Error("非法上下文用量");
    this.records.set(`${u.backend}:${u.key}`, structuredClone(u));
    this.revision++;
    trace.event(ticket, "context_usage", { detail: u });
    for (const fn of this.listeners) {
      try { fn(structuredClone(u)); } catch { /* 面板故障不影响回合 */ }
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(() => log.warn("context usage persistence failed; will retry on next update or shutdown"));
    }, this.debounceMs);
    this.timer.unref();
  }

  /** 串行原子替换，写入期间的新更新由后续批次保存；失败保留待写状态。 */
  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const run = this.writes.catch(() => undefined).then(async () => {
      if (this.savedRevision === this.revision) return;
      const revision = this.revision;
      const body = JSON.stringify(Object.fromEntries(this.records), null, 2) + "\n";
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await fs.rename(temp, this.file);
        this.savedRevision = revision;
      } finally { await fs.unlink(temp).catch(() => undefined); }
    });
    this.writes = run;
    return run;
  }

  async close(): Promise<void> { await this.flush(); this.listeners.clear(); }
}

import type { ContextUsage } from '../../../src/shared/format.js';

/** 与 ContextUsageStore 同形的内存桩：all / get / subscribe，set 时通知订阅者。 */
export class ContextUsageStub {
  private readonly map = new Map<string, ContextUsage>();
  private readonly subs = new Set<(u: ContextUsage) => void>();
  constructor(list: ContextUsage[] = []) { for (const u of list) this.map.set(`${u.backend}|${u.key}`, u); }
  all(): ContextUsage[] { return [...this.map.values()]; }
  get(backend: ContextUsage['backend'], key: string): ContextUsage | undefined { return this.map.get(`${backend}|${key}`); }
  subscribe(fn: (u: ContextUsage) => void): () => void { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
  set(u: ContextUsage): void { this.map.set(`${u.backend}|${u.key}`, u); for (const fn of this.subs) fn(u); }
}

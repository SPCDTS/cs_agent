import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { ObsStore } from '../../src/obs/store.js';
import { Metrics } from '../../src/obs/metrics.js';

it('trace 清理与 ObsStore 每日 purge 同步，辅助清理失败不降级观测库', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cs-trace-purge-')), store = new ObsStore(dir);
  try {
    const onPurge = vi.fn(async () => { throw new Error('临时不可读'); }), purge = vi.spyOn(store, 'purge');
    const metrics = new Metrics(store, { retentionDays: 30, onPurge });
    const now = Date.UTC(2026, 9, 18);
    await metrics.flush(now); await metrics.flush(now + 1000); await metrics.flush(now + 86_400_000);
    expect(purge).toHaveBeenCalledTimes(2); expect(onPurge).toHaveBeenCalledTimes(2);
    expect(onPurge).toHaveBeenLastCalledWith(now + 86_400_000); expect(store.degraded).toBe(false);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

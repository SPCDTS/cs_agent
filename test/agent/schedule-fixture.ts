import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, Harness, type Tx } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { vi } from "vitest";
import { createScheduleTask } from "../../src/agent/schedule/task.js";
import { ScheduleService } from "../../src/agent/schedule/service.js";
import type { ScheduledFire, ScheduledRunAdmitter, ScheduledRunLauncher } from "../../src/agent/schedule/types.js";
import { recordRunInTransaction } from "../../src/agent/schedule/records.js";

export const ctx = BACKGROUND_CONTEXT;
export const START = Date.parse("2026-10-20T00:00:00Z");
export const owner = "qq:1";
export const input = (overrides = {}) => ({
  name: "日报", prompt: "需要时通知", conversation: "owner",
  rule: { kind: "rrule", rrule: "FREQ=MINUTELY;INTERVAL=5", dtstart: START },
  ...overrides,
});

export class AdmitterStub implements ScheduledRunAdmitter, ScheduledRunLauncher {
  calls: ScheduledFire[] = [];
  fail = false;
  reject = false;
  prepareError = false;
  async prepare(_fire: ScheduledFire) { if (this.prepareError) throw new Error("prepare failed"); return this; }
  launch(_key: string) {}
  async admit(tx: unknown, fire: ScheduledFire) {
    if (this.reject) throw new Error("admission failed");
    this.calls.push(fire);
    const ticket = `run_test_${fire.fire_key}`;
    if (this.fail) await recordRunInTransaction(tx as Tx, fire.schedule.id, {
      fire_key: fire.fire_key, fire_at: fire.fire_at, status: "failed", reason: "backend_failed",
    }, Date.now());
    return { ticket };
  }
}

export async function flush(check: () => Promise<boolean> | boolean = () => true): Promise<void> {
  for (let n = 0; n < 300; n++) {
    await setImmediate();
    if (await check()) return;
  }
  throw new Error("调度器未到达预期检查点");
}

export async function rig(options: { owners?: readonly string[]; canSchedule?: (actor: string) => boolean | Promise<boolean>; admitter?: AdmitterStub } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cs-schedule-"));
  const admitter = options.admitter ?? new AdmitterStub(), event = vi.fn();
  const task = createScheduleTask({ admitter, trace: { event } });
  const extension = defineExtension({ name: "schedule-test", tasks: [task] });
  const registry = createRegistry(); registry.install(extension);
  let harness: Harness, service: ScheduleService;
  const reports: unknown[] = [];
  const open = async () => {
    harness = await Harness.open(await openNodeSqliteStorage(path.join(dir, "agent.sqlite")), {
      registry, models: createModels(), now: () => Date.now(), onReport: error => reports.push(error),
    }, ctx);
    service = new ScheduleService({ harness, task, admitter, owner: "1", owners: options.owners, now: () => Date.now(),
      canSchedule: options.canSchedule, trace: { event } });
    await service.start();
  };
  await open();
  return {
    get harness() { return harness; }, get service() { return service; }, admitter, event, reports, task,
    async restart() { service.stop(); await harness.close(ctx); await open(); },
    async close() { service.stop(); await harness.close(ctx); rmSync(dir, { recursive: true, force: true }); },
  };
}

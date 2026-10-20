import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { MemoryStorage, type Harness } from "@earendil-works/pi-durable";
import { afterEach, vi } from "vitest";
import type { GrantBinding } from "../../src/agent/grants.js";
import { GrantsService } from "../../src/agent/grants.js";
import { openHarness } from "../../src/agent/harness.js";
import { createCsAgentExtension } from "../../src/agent/extension.js";
import { createTasks } from "../../src/agent/tasks.js";
import { createBackendSelector } from "../../src/agent/backends/select.js";
import { createScheduledRuntime } from "../../src/agent/schedule/run.js";
import { ScheduleService } from "../../src/agent/schedule/service.js";
import { createScheduleTask } from "../../src/agent/schedule/task.js";
import { ScheduleTools } from "../../src/agent/schedule/tools.js";
import { formatBeijingTime } from "../../src/agent/schedule/tool-schema.js";
import { sendFixture } from "./send-fixture.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
export async function scheduleToolsFixture() {
  const f = sendFixture();
  let harness!: Harness, service!: ScheduleService;
  const event = vi.fn();
  const grants = new GrantsService({ owner: "1", getChannel: () => f.bridge, getHarness: () => harness });
  const tasks = createTasks({
    owner: "1", getBridge: () => f.bridge, sendService: f.service, imagesDir: path.join(f.dir, "images"),
    imageBackend: { name: "test", submit: async () => "job", collect: async () => [],
      reconcile: async () => ({ images: [] }), clearReferences: async () => {} },
    backends: createBackendSelector({ defaultBackend: "codex", overrides: {}, backends: {
      codex: { name: "codex", handle: async () => ({ text: "无需通知" }) },
    } }),
  });
  const canSchedule = grants.canSchedule.bind(grants);
  const runtime = createScheduledRuntime({ tasks, owner: "1", getChannel: () => f.bridge, canSchedule,
    recorder: { recordRun: (id, run) => service.recordRun(id, run) },
    pauseSchedule: (id, reason) => service.pauseWithReason(id, reason),
  });
  const launcher = { prepare: runtime.prepare, dispatchScheduled: vi.fn() };
  const task = createScheduleTask({ admitter: launcher });
  harness = await openHarness({ models: createModels(), storage: new MemoryStorage(),
    extension: createCsAgentExtension(tasks, [task, runtime.ScheduledTask]) }, BACKGROUND_CONTEXT);
  cleanup.push(() => harness.close(BACKGROUND_CONTEXT));
  service = new ScheduleService({ harness, task, admitter: launcher, owner: "1", canSchedule });
  const tools = new ScheduleTools({ grants, getHarness: () => harness, getSchedules: () => service, trace: { event } });
  let seq = 0;
  const binding = (user = "1", group: string | null = "7"): GrantBinding => {
    const ticket = f.store.createTicket({ ...f.msg, user_id: user, message_type: group ? "group" : "private",
      group_id: group, message_id: "schedule-tool-" + ++seq });
    return { ticket, actor: `qq:${user}`, actorIsOwner: user === "1",
      source: { type: group ? "group" : "private", user_id: user, group_id: group } };
  };
  const args = { name: "监控日报", prompt: "检查新消息，无新内容则静默；有更新发到 qq:group:7（家庭群）",
    rule: { rrule: "FREQ=DAILY;BYHOUR=8;BYMINUTE=30", start: formatBeijingTime(Date.now() + 86_400_000) } };
  const create = async (bound = binding()) => {
    await tools.tool(bound, "schedule_create", args);
    return (await service.list(bound.actor)).at(-1)!;
  };
  const scheduled = async (id: string, actor = "qq:1"): Promise<GrantBinding> => {
    const run = await service.runNow(actor, id);
    const rec = (await f.bridge.getTicket(run.ticket!))!;
    return { ticket: run.ticket!, actor, actorIsOwner: actor === "qq:1",
      source: { type: rec.message_type, user_id: rec.user_id, group_id: rec.group_id } };
  };
  return { ...f, grants, tools, service, harness, event, binding, args, create, scheduled, launcher };
}

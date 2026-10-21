import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { defineExtension, MemoryStorage, type Harness } from "@earendil-works/pi-durable";
import { afterEach, vi } from "vitest";
import type { GrantBinding } from "../../src/agent/grants.js";
import { GrantsService } from "../../src/agent/grants.js";
import { openHarness } from "../../src/agent/harness.js";
import { createScheduledRuntime } from "../../src/agent/schedule/run.js";
import { ScheduleService } from "../../src/agent/schedule/service.js";
import { createScheduleTask } from "../../src/agent/schedule/task.js";
import { ScheduleTools } from "../../src/agent/schedule/tools.js";
import { formatBeijingTime } from "../../src/agent/schedule/tool-schema.js";
import { bridgeFixture } from "./grants-fixture.js";

type Bound = GrantBinding & { actor: string; inputKey?: string };

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
/** 定时工具测试台：授权、排程与定时运行共用一个派发 harness；投递交给 deliver 桩（不跑回合）。 */
export async function scheduleToolsFixture() {
  const f = bridgeFixture();
  let harness!: Harness, service!: ScheduleService;
  const event = vi.fn();
  const grants = new GrantsService({ owner: "1", getHarness: () => harness });
  const canSchedule = grants.canSchedule.bind(grants);
  const deliver = vi.fn(async (_key: string) => {});
  const runtime = createScheduledRuntime({ owner: "1", getChannel: () => f.bridge, getHarness: () => harness, canSchedule, deliver,
    recorder: { recordRun: (id, run) => service.recordRun(id, run) },
    pauseSchedule: (id, reason) => service.pauseWithReason(id, reason),
  });
  const launcher = { prepare: runtime.prepare, launch: vi.fn() };
  const task = createScheduleTask({ admitter: launcher });
  harness = await openHarness({ models: createModels(), storage: new MemoryStorage(),
    extension: defineExtension({ name: "schedule-tools-test", tasks: [task] }) }, BACKGROUND_CONTEXT);
  cleanup.push(() => harness.close(BACKGROUND_CONTEXT));
  service = new ScheduleService({ harness, task, admitter: launcher, owner: "1", canSchedule });
  const tools = new ScheduleTools({ grants, getHarness: () => harness, getSchedules: () => service, trace: { event } });
  /** 用户回合的本轮绑定：群 group 或私聊中 user 发起（owner 私聊的会话键为 owner）。 */
  const binding = (user = "1", group: string | null = "7"): Bound => ({
    threadKey: group ? `group:${group}` : user === "1" ? "owner" : `private:${user}`,
    identity: { kind: "user", sender: user }, scope: group ? `group:${group}` : `private:${user}`, inputs: [], actor: `qq:${user}`,
  });
  const args = { name: "监控日报", prompt: "检查新消息，无新内容则静默；有更新发到 qq:group:7（家庭群）",
    rule: { rrule: "FREQ=DAILY;BYHOUR=8;BYMINUTE=30", start: formatBeijingTime(Date.now() + 86_400_000) } };
  const create = async (bound = binding()) => {
    await tools.tool(bound, "schedule_create", args);
    return (await service.list(bound.actor)).at(-1)!;
  };
  /** 立即运行后的定时回合绑定：身份为创建者，本轮输入为该次运行的定时输入。 */
  const scheduled = async (id: string, actor = "qq:1"): Promise<Bound> => {
    const run = await service.runNow(actor, id);
    const input = f.bridge.inbox.getInbound(run.ticket!)!;
    return { threadKey: input.thread_key, identity: { kind: "scheduled", creator: actor.slice(3) }, scope: input.scope,
      inputs: [input.key], inputKey: input.key, actor };
  };
  return { ...f, grants, tools, service, harness, event, binding, args, create, scheduled, launcher, deliver, runtime };
}

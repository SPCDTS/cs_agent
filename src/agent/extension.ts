import { defineExtension } from "@earendil-works/pi-durable";
import type { CsTasks } from "./tasks.js";
import type { ScheduledRuntime } from "./schedule/run.js";

const EXTENSION_NAME = "cs-agent";

/**
 * v3：不再有面向模型的工具与系统提示（意图模型的 route 会话已退场）。
 * 注册生图 / agent 任务；主进程传入定时运行工厂时一并注册 cs.scheduled。
 */
export function createCsAgentExtension(tasks: CsTasks, scheduled?: Pick<ScheduledRuntime, "ScheduledTask">) {
  return defineExtension({
    name: EXTENSION_NAME,
    tasks: [tasks.ImageTask, tasks.AgentTask, ...(scheduled ? [scheduled.ScheduledTask] : [])],
  });
}

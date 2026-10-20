import { defineExtension, type AnyTask } from "@earendil-works/pi-durable";
import type { CsTasks } from "./tasks.js";

const EXTENSION_NAME = "cs-agent";

/**
 * v3：不再有面向模型的工具与系统提示（意图模型的 route 会话已退场）。
 * 注册生图 / agent durable 任务，并接受宿主注入的后台任务（如 cs.schedule）。
 */
export function createCsAgentExtension(tasks: CsTasks, additionalTasks: readonly AnyTask[] = []) {
  return defineExtension({
    name: EXTENSION_NAME,
    tasks: [tasks.ImageTask, tasks.AgentTask, ...additionalTasks],
  });
}

import { defineExtension, type AnyTask } from "@earendil-works/pi-durable";
import type { CsTasks } from "./tasks.js";

const EXTENSION_NAME = "cs-agent";

/**
 * 派发 harness 的扩展：不再有面向模型的工具与系统提示；注册生图任务与宿主注入的排程任务。
 * agent 回合由 ThreadHost 交给后端适配器，不再是派发任务（第 2 阶段起）。
 */
export function createCsAgentExtension(tasks: CsTasks, additionalTasks: readonly AnyTask[] = []) {
  return defineExtension({
    name: EXTENSION_NAME,
    tasks: [tasks.ImageTask, ...additionalTasks],
  });
}

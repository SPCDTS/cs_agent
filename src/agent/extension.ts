import { defineExtension, type AnyTask } from "@earendil-works/pi-durable";

const EXTENSION_NAME = "cs-agent";

/**
 * 派发 harness 的扩展：不再有面向模型的工具与系统提示；只注册宿主注入的排程任务。
 * agent 回合由 ThreadHost 交给后端适配器，不是派发任务。
 */
export function createCsAgentExtension(tasks: readonly AnyTask[] = []) {
  return defineExtension({
    name: EXTENSION_NAME,
    tasks: [...tasks],
  });
}

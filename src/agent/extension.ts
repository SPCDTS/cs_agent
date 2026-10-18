import { defineExtension } from "@earendil-works/pi-durable";
import type { CsTasks } from "./tasks.js";

const EXTENSION_NAME = "cs-agent";

/**
 * v3：不再有面向模型的工具与系统提示（意图模型的 route 会话已退场）。
 * 扩展只注册两个 durable 任务（生图 / agent）；pi 后端（第 3 组）会在这里加入自己的工具与提示段。
 */
export function createCsAgentExtension(tasks: CsTasks) {
  return defineExtension({
    name: EXTENSION_NAME,
    tasks: [tasks.ImageTask, tasks.AgentTask],
  });
}

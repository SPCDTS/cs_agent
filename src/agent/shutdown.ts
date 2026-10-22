import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import type { PiBackend } from "./backends/pi.js";

/** 先关派发 harness，防止 pi 关闭造成的等待错误被派发任务误存为失败结果。
 * 提前设置关闭标记后，任务 signal 仅停止等待；最后关闭 pi harness 保留 submission 检查点。
 */
export async function closeAgentHarnesses(harness: Harness, pi: PiBackend): Promise<void> {
  pi.beginShutdown();
  try { await harness.close(BACKGROUND_CONTEXT); }
  finally { await pi.close(); }
}

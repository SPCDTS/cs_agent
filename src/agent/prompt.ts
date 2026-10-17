/**
 * v2 的热加载系统提示 ${DATA_DIR}/prompts/system.md 在 v3 不再使用（规则分流不经模型）。
 * 文件保留不删；启动时若存在则记一行弃用日志。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { log } from "../log.js";

export function systemPromptFile(dataDir: string): string {
  return path.join(dataDir, "prompts", "system.md");
}

/** 存在旧的 system.md 时记一行 warn（不读取、不删除）。返回是否存在。 */
export function warnDeprecatedSystemPrompt(dataDir: string): boolean {
  const file = systemPromptFile(dataDir);
  if (!existsSync(file)) return false;
  log.warn("system.md is deprecated and no longer used (v3 rule router); file kept as is", { file });
  return true;
}

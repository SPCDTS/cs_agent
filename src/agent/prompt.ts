/**
 * 系统提示热加载：读取 ${DATA_DIR}/prompts/system.md，按 mtime/size 缓存。
 * pi-durable 每次模型请求前重建 section，因此改文件后下一条消息即生效，无需重启。
 * 文件缺失、为空或读取失败时回退到内置 SYSTEM_PROMPT；从不抛错。
 */
import { promises as fs, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { log } from "../log.js";
import { SYSTEM_PROMPT } from "./extension.js";

export function systemPromptFile(dataDir: string): string {
  return path.join(dataDir, "prompts", "system.md");
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  /** 文件内容；为空（trim 后）时为 undefined，表示回退内置提示 */
  text: string | undefined;
}

const cache = new Map<string, CacheEntry>();

/** 返回当前生效的系统提示：文件内容（非空时）或内置 SYSTEM_PROMPT。 */
export function loadSystemPrompt(dataDir: string, fallback: string = SYSTEM_PROMPT): string {
  const file = systemPromptFile(dataDir);
  try {
    const st = statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text ?? fallback;
    const raw = readFileSync(file, "utf8");
    const text = raw.trim() ? raw : undefined;
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, text });
    if (text) {
      log.info("system prompt reloaded", { file, size: st.size, mtime: new Date(st.mtimeMs).toISOString() });
    } else {
      log.warn("system prompt file is empty, using built-in prompt", { file });
    }
    return text ?? fallback;
  } catch {
    // 文件不存在或读取失败：回退内置提示；清掉缓存，文件恢复后会重新读取并记日志
    cache.delete(file);
    return fallback;
  }
}

/** 文件不存在时写入内置提示（wx，不覆盖运维修改）。返回是否新建。 */
export async function ensureDefaultSystemPrompt(dataDir: string, content: string = SYSTEM_PROMPT): Promise<boolean> {
  const file = systemPromptFile(dataDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(file, content.endsWith("\n") ? content : `${content}\n`, { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "../log.js";

const exec = promisify(execFile);

/** debug models 的顶层为 {models: [...] }，按 slug 精确选择，使用 context_window 原值。 */
export function catalogContextWindow(json: string, model: string): number | undefined {
  const catalog = JSON.parse(json) as { models?: { slug?: string; context_window?: unknown }[] };
  if (!Array.isArray(catalog?.models)) return undefined;
  const value = catalog.models.find(m => m?.slug === model)?.context_window;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** 调用方缓存 Promise；只查询目录，不启动模型回合。失败日志不包含子进程输出或环境。 */
export async function loadCodexContextWindow(opts: {
  command: string[]; model: string; env: NodeJS.ProcessEnv; fallback?: number;
}): Promise<number> {
  try {
    const [bin, ...prefix] = opts.command;
    if (!bin) throw new Error("missing binary");
    const { stdout } = await exec(bin, [...prefix, "debug", "models"], {
      env: opts.env, encoding: "utf8", timeout: 15_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    });
    const windowTokens = catalogContextWindow(stdout, opts.model);
    if (windowTokens) {
      log.info("codex context window", { model: opts.model, windowTokens, source: "catalog.context_window" });
      return windowTokens;
    }
  } catch { /* 缺少命令、目录不可用或格式变化均回退 */ }
  const windowTokens = opts.fallback ?? 400000;
  log.warn("codex context window", { model: opts.model, windowTokens, source: opts.fallback === undefined ? "default" : "CODEX_CONTEXT_WINDOW" });
  return windowTokens;
}

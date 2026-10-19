import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import { log } from "../../shared/log.js";

const exec = promisify(execFile);

/** debug models 的顶层为 {models: [...] }；精确匹配优先，其次忽略提供者前缀。 */
const unprefixedModel = (model: string) => model.replace(/^[^/]+\//, "");
export function catalogContextWindow(json: string, model: string): number | undefined {
  const catalog = JSON.parse(json) as { models?: { slug?: string; context_window?: unknown }[] };
  if (!Array.isArray(catalog?.models)) return undefined;
  const selected = catalog.models.find(m => m?.slug === model)
    ?? catalog.models.find(m => typeof m?.slug === "string" && unprefixedModel(m.slug) === unprefixedModel(model));
  const value = selected?.context_window;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** 调用方缓存 Promise；只查询目录，不启动模型回合。失败日志不包含子进程输出或环境。 */
export async function loadCodexContextWindow(opts: {
  command: string[]; model: string; env: NodeJS.ProcessEnv; fallback?: number; cacheFile?: string;
}): Promise<number> {
  let catalogWindow: number | undefined, offline = false;
  try {
    const [bin, ...prefix] = opts.command;
    if (!bin) throw new Error("missing binary");
    const { stdout } = await exec(bin, [...prefix, "debug", "models"], {
      env: opts.env, encoding: "utf8", timeout: 15_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    });
    catalogWindow = catalogContextWindow(stdout, opts.model);
    const catalog = JSON.parse(stdout) as { models?: { context_window?: unknown }[] };
    // 内置离线目录将所有模型设为同一窗口；正常目录始终优先于本地缓存。
    offline = !!catalogWindow && Array.isArray(catalog?.models) && catalog.models.length > 0
      && catalog.models.every(model => model?.context_window === catalogWindow);
  } catch { /* 缺少命令、目录不可用或格式变化时尝试只读缓存。 */ }
  if (opts.cacheFile && (!catalogWindow || offline)) {
    try {
      const windowTokens = catalogContextWindow(await fs.readFile(opts.cacheFile, "utf8"), opts.model);
      if (windowTokens && windowTokens !== catalogWindow) {
        log.info("codex context window", { model: opts.model, windowTokens, source: "cache.context_window" });
        return windowTokens;
      }
    } catch { /* 缓存缺失、不可读或损坏不阻断原有回退。 */ }
  }
  if (catalogWindow) {
    log.info("codex context window", { model: opts.model, windowTokens: catalogWindow, source: "catalog.context_window" });
    return catalogWindow;
  }
  const windowTokens = opts.fallback ?? 400000;
  log.warn("codex context window", { model: opts.model, windowTokens, source: opts.fallback === undefined ? "default" : "CODEX_CONTEXT_WINDOW" });
  return windowTokens;
}

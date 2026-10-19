import { mkdirSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Context } from "@earendil-works/chord";
import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model, type Models, type MutableModels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createRegistry, Harness, type Extension, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodexAuthFileStore } from "./codex/oauth.js";
import { log } from "../shared/log.js";
import { createMagpieProvider, fetchMagpieCatalog, magpieProviderModels, type MagpieCatalogEntry } from "./magpie-models.js";

/**
 * 内置 provider 全部注册（deepseek / openai-codex / openai / anthropic …，由 AGENT_MODEL_PROVIDER 选择）。
 * openai-codex 的凭据来自 ${codexHome}/auth.json；API key provider（deepseek 读 DEEPSEEK_API_KEY 等）读环境变量。
 */
export async function createAgentModels(
  codexHome: string,
  magpie?: { baseUrl: string; apiKey: string },
  deps: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): Promise<MutableModels> {
  const models = builtinModels({ credentials: new CodexAuthFileStore(path.join(codexHome, "auth.json")) });
  if (!magpie) return models;
  let entries: MagpieCatalogEntry[];
  for (let retries = 0; ; retries++) {
    try {
      entries = await fetchMagpieCatalog(magpie.baseUrl, magpie.apiKey, deps.fetch);
      break;
    } catch (error) {
      // 首次失败后最多重试 5 次，避免网关启动稍晚导致立即退出。
      if (retries === 5) throw new Error(`magpie 模型目录不可达: ${error instanceof Error ? error.message : String(error)}`);
      await (deps.sleep ?? sleep)(3000);
    }
  }
  models.setProvider(createMagpieProvider({ baseUrl: magpie.baseUrl, models: magpieProviderModels(entries, models) }));
  return models;
}

/** 把配置的思考档位收敛到模型支持的档位（不支持时就近取值；无推理能力的模型为 off）。 */
export function resolveThinkingLevel(model: Model<Api>, level: ModelThinkingLevel): ModelThinkingLevel {
  return clampThinkingLevel(model, level);
}

/** 面板 pi 模型下拉：提供者下的模型、窗口与可选档位（与 clampThinkingLevel 同一判定，不含 auto）。 */
export function piModelCatalog(models: Pick<Models, "getModels">, provider: string): { id: string; contextWindow: number; thinkingLevels: string[] }[] {
  try {
    return models.getModels(provider).map(m => ({ id: m.id, contextWindow: m.contextWindow, thinkingLevels: getSupportedThinkingLevels(m) }));
  } catch { return []; }
}

export interface OpenHarnessOptions {
  models: Models;
  extension: Extension;
  /** SQLite 文件路径；传入 storage 时忽略 */
  dbFile?: string;
  storage?: Storage;
}

export async function openHarness(opts: OpenHarnessOptions, context: Context): Promise<Harness> {
  let storage = opts.storage;
  if (!storage) {
    if (!opts.dbFile) throw new Error("dbFile or storage required");
    mkdirSync(path.dirname(opts.dbFile), { recursive: true });
    storage = await openNodeSqliteStorage(opts.dbFile);
  }
  const registry = createRegistry();
  registry.install(opts.extension);
  return Harness.open(
    storage,
    {
      models: opts.models,
      registry,
      settings: {
        extensions: [opts.extension],
        toolExecution: "sequential",
        retry: { maxRetries: 2 },
        compaction: { enabled: false },
      },
      onReport: (err) => log.warn("harness report", { error: err instanceof Error ? err.message : String(err) }),
    },
    context,
  );
}

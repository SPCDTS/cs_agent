import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Context } from "@earendil-works/chord";
import { clampThinkingLevel, type Api, type Model, type Models, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createRegistry, Harness, type Extension, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodexAuthFileStore } from "./codex/oauth.js";
import { log } from "../shared/log.js";

/**
 * 内置 provider 全部注册（deepseek / openai-codex / openai / anthropic …，由 AGENT_MODEL_PROVIDER 选择）。
 * openai-codex 的凭据来自 ${codexHome}/auth.json；API key provider（deepseek 读 DEEPSEEK_API_KEY 等）读环境变量。
 */
export function createAgentModels(codexHome: string): Models {
  return builtinModels({ credentials: new CodexAuthFileStore(path.join(codexHome, "auth.json")) });
}

/** 把配置的思考档位收敛到模型支持的档位（不支持时就近取值；无推理能力的模型为 off）。 */
export function resolveThinkingLevel(model: Model<Api>, level: ModelThinkingLevel): ModelThinkingLevel {
  return clampThinkingLevel(model, level);
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

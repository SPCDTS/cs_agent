import { createServer, type Server } from "node:http";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { applyEnvAliases, loadConfig, requireProviderApiKey, type Config } from "./config.js";
import { log, setLogLevel } from "./log.js";
import { findUnwritable, processIdentity } from "./fs-check.js";
import { createQQBridge } from "./qq/index.js";
import type { QQBridge } from "./qq/types.js";
import { createAgentModels, openHarness, resolveThinkingLevel } from "./agent/harness.js";
import { createCsAgentExtension } from "./agent/extension.js";
import { ensureDefaultSystemPrompt, loadSystemPrompt, systemPromptFile } from "./agent/prompt.js";
import { Dispatcher } from "./agent/dispatch.js";
import { CodexRunner, createAskCodexTool, ensureWorkspaceAgentsMd } from "./agent/tools/ask-codex.js";
import { createGenerateImageTool, HttpImageBackend, McpImageBackend, type ImageBackend } from "./agent/tools/generate-image.js";
import { createReplyQQTool } from "./agent/tools/reply-qq.js";
import { isLoopbackUrl, startLoopbackProxy } from "./agent/loopback-proxy.js";
import { ContextStore } from "./context/store.js";
import { startAgingScheduler } from "./context/aging.js";

function createImageBackend(cfg: Config, comfyUrlForMcp: string): ImageBackend {
  const timeoutMs = cfg.COMFY_TIMEOUT_SEC * 1000;
  const checkpoint = cfg.COMFY_CHECKPOINT || undefined;
  const workflowFile = cfg.COMFY_WORKFLOW_FILE || undefined;
  const promptNode = cfg.COMFY_PROMPT_NODE || undefined;
  if (cfg.COMFY_MODE === "http") {
    return new HttpImageBackend({ baseUrl: cfg.COMFYUI_URL, timeoutMs, checkpoint, workflowFile, promptNode });
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  Object.assign(env, { COMFYUI_URL: comfyUrlForMcp, COMFY_BIN: cfg.COMFY_BIN });
  return new McpImageBackend({ command: cfg.COMFY_MCP_BIN, env, timeoutMs, checkpoint, workflowFile, promptNode });
}

async function main(): Promise<void> {
  // DEEPSEEK_APIKEY 等别名 → pi-ai 读取的标准变量名（须在创建 models 之前）
  applyEnvAliases(process.env);
  const cfg = loadConfig();
  requireProviderApiKey(cfg.AGENT_MODEL_PROVIDER);
  setLogLevel(cfg.LOG_LEVEL);
  const ctx = BACKGROUND_CONTEXT;
  log.info("starting cs-agent", {
    provider: cfg.AGENT_MODEL_PROVIDER,
    model: cfg.AGENT_MODEL_ID,
    comfy_mode: cfg.COMFY_MODE,
    data_dir: cfg.DATA_DIR,
  });

  // 数据卷必须可写（容器以 node 用户运行，宿主机目录权限不对时尽早给出明确错误）
  const unwritable = await findUnwritable([cfg.DATA_DIR, cfg.WORKSPACE_DIR]);
  if (unwritable.length) {
    for (const { dir, reason } of unwritable) {
      log.error("directory not writable", {
        dir,
        reason,
        user: processIdentity(),
        hint: "fix ownership/permissions of the mounted volume on the host (container runs as the node user)",
      });
    }
    process.exit(1);
  }

  // codex 读取的工作区规则（不泄露凭据/环境变量）；已存在则不覆盖
  if (await ensureWorkspaceAgentsMd(cfg.WORKSPACE_DIR)) log.info("wrote workspace AGENTS.md", { dir: cfg.WORKSPACE_DIR });
  // 可热改的系统提示（${DATA_DIR}/prompts/system.md）；已存在则不覆盖
  if (await ensureDefaultSystemPrompt(cfg.DATA_DIR)) log.info("wrote default system prompt", { file: systemPromptFile(cfg.DATA_DIR) });

  // 统一上下文消息库（${DATA_DIR}/qq-messages.sqlite）：意图层与 codex 的 qq_context MCP 共用
  const store = new ContextStore(cfg.DATA_DIR);

  let bridge: QQBridge | undefined;
  const getBridge = () => {
    if (!bridge) throw new Error("QQBridge 未就绪");
    return bridge;
  };

  // comfy-cli 只对 loopback 目标获取 object_info：非 loopback 的 COMFYUI_URL 经容器内转发
  const comfyProxy =
    cfg.COMFY_MODE === "mcp" && !isLoopbackUrl(cfg.COMFYUI_URL)
      ? await startLoopbackProxy(cfg.COMFYUI_URL, cfg.COMFY_LOOPBACK_PORT)
      : undefined;
  const imageBackend = createImageBackend(cfg, comfyProxy?.url ?? cfg.COMFYUI_URL);
  const codex = new CodexRunner({
    command: [cfg.CODEX_BIN],
    codexHome: cfg.codexHome,
    workspaceDir: cfg.WORKSPACE_DIR,
    sessionFile: path.join(cfg.DATA_DIR, "codex-session.json"),
    sandbox: cfg.CODEX_SANDBOX,
    timeoutMs: cfg.CODEX_TIMEOUT_SEC * 1000,
  });

  const extension = createCsAgentExtension([
    createGenerateImageTool(imageBackend, cfg.imagesDir),
    createAskCodexTool(codex),
    createReplyQQTool(getBridge, cfg.imagesDir),
  ], () => loadSystemPrompt(cfg.DATA_DIR));
  const models = createAgentModels(cfg.codexHome);
  const agentModel = models.getModel(cfg.AGENT_MODEL_PROVIDER, cfg.AGENT_MODEL_ID);
  if (!agentModel) {
    throw new Error(`未知模型 ${cfg.AGENT_MODEL_PROVIDER}/${cfg.AGENT_MODEL_ID}`);
  }
  // 模型不支持所配置的思考档位时就近取支持的档位（例如 deepseek-flash 无 medium → high），而不是请求失败
  const thinkingLevel = resolveThinkingLevel(agentModel, cfg.AGENT_THINKING_LEVEL);
  if (thinkingLevel !== cfg.AGENT_THINKING_LEVEL) {
    log.warn("AGENT_THINKING_LEVEL not supported by model, adjusted", {
      model: `${cfg.AGENT_MODEL_PROVIDER}/${cfg.AGENT_MODEL_ID}`,
      configured: cfg.AGENT_THINKING_LEVEL,
      effective: thinkingLevel,
    });
  }
  const harness = await openHarness({ models, extension, dbFile: path.join(cfg.DATA_DIR, "agent.sqlite") }, ctx);

  bridge = createQQBridge({
    httpUrl: cfg.NAPCAT_HTTP_URL,
    wsUrl: cfg.NAPCAT_WS_URL,
    token: cfg.NAPCAT_TOKEN,
    allowUsers: cfg.allowUsers,
    allowGroups: cfg.QQ_ALLOW_GROUPS,
    groupMentions: cfg.QQ_GROUP_MENTIONS,
    dataDir: cfg.DATA_DIR,
    imageRoot: cfg.imagesDir,
  });

  const dispatcher = new Dispatcher({
    harness,
    bridge,
    model: { provider: cfg.AGENT_MODEL_PROVIDER, modelId: cfg.AGENT_MODEL_ID },
    thinkingLevel,
    concurrency: cfg.AGENT_CONCURRENCY,
    history: store,
  });

  // 聊天记录衰老（日/周摘要 + 清理）：每天 HISTORY_SUMMARY_HOUR 点（容器本地时区，默认 UTC）；启动时补跑
  const aging = startAgingScheduler({
    store,
    models,
    model: agentModel,
    rawDays: cfg.HISTORY_RAW_DAYS,
    summaryDays: cfg.HISTORY_SUMMARY_DAYS,
    hour: cfg.HISTORY_SUMMARY_HOUR,
  });

  // 继续上次未完成的工作（工具非 replay-safe：中断的调用以 interrupted 结果交给模型）
  harness.resume();
  await dispatcher.recover();

  // raw 先于 message 发出：入站消息先入库，派发器再写机器人"处理中"行
  bridge.on("raw", (msg) => {
    try {
      store.ingest(msg);
    } catch (err) {
      log.warn("context ingest failed", { error: err });
    }
  });
  bridge.on("recall", (scope, messageId) => {
    try {
      store.recall(scope, messageId);
    } catch (err) {
      log.warn("context recall failed", { error: err });
    }
  });
  bridge.on("message", (msg, ticket) => void dispatcher.dispatch(msg, ticket));
  bridge.on("connection", () => log.info("napcat connected"));
  bridge.on("disconnect", (reason) => log.warn("napcat disconnected", { reason }));
  bridge.on("error", (err) => log.error("bridge error", { error: err }));
  await bridge.start();

  // 自检（不阻塞启动）
  const checks: Record<string, unknown> = { comfy: "pending", codex: "pending" };
  imageBackend
    .selfCheck()
    .then((info) => {
      checks.comfy = { ok: true, backend: info.backend, server: info.server, comfy_target: info.comfy_target, comfyui_version: info.comfyui_version };
      log.info("comfy self-check ok", { info });
    })
    .catch((err) => {
      checks.comfy = { ok: false, error: (err as Error).message };
      log.warn("comfy self-check failed", { error: err });
    });
  codex
    .readSessionId()
    .then(async (id) => {
      const { access } = await import("node:fs/promises");
      const authOk = await access(path.join(cfg.codexHome, "auth.json")).then(() => true, () => false);
      checks.codex = { ok: authOk, auth_json: authOk, session: id ?? null };
    })
    .catch((err) => (checks.codex = { ok: false, error: (err as Error).message }));

  const server: Server = createServer((req, res) => {
    if (req.url !== "/healthz") {
      res.writeHead(404).end();
      return;
    }
    const st = bridge!.status();
    const body = { ok: st.ws_connected, ws_connected: st.ws_connected, bridge: st, ...checks };
    res.writeHead(st.ws_connected ? 200 : 503, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  });
  server.listen(cfg.HEALTH_PORT, cfg.HEALTH_HOST, () => log.info("healthz listening", { port: cfg.HEALTH_PORT }));

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("shutting down", { signal });
    const force = setTimeout(() => process.exit(1), 20_000);
    force.unref();
    server.close();
    aging.stop();
    await bridge!.stop().catch(() => undefined);
    await harness.close(ctx).catch(() => undefined);
    try {
      store.close();
    } catch {
      /* ignore */
    }
    await imageBackend.close().catch(() => undefined);
    await comfyProxy?.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  log.error("fatal", { error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
  process.exit(1);
});

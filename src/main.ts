import { cleanupIncoming } from "./qq/incoming.js";
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
import { warnDeprecatedSystemPrompt } from "./agent/prompt.js";
import { PiPromptLoader } from "./agent/pi-tools/prompt.js";
import { Dispatcher } from "./agent/dispatch.js";
import { CodexRunner, effectiveWritableRoots, ensureWorkspaceAgentsMd, writeGlobalAgentsMd } from "./agent/codex-runner.js";
import { createImageBackend } from "./agent/image-gen.js";
import { isLoopbackUrl, startLoopbackProxy } from "./agent/loopback-proxy.js";
import { createTasks } from "./agent/tasks.js";
import { CodexBackend } from "./agent/backends/codex.js";
import { createBackendSelector, PiBackend } from "./agent/backends/select.js";
import { ContextStore } from "./context/store.js";
import { startAgingScheduler } from "./context/aging.js";

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
    agent_backend: cfg.AGENT_BACKEND,
    backend_overrides: cfg.backendOverrides,
    codex_reply_mode: cfg.CODEX_REPLY_MODE,
    image_prefixes: cfg.imagePrefixes,
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

  // codex 规则：受管的全局 $CODEX_HOME/AGENTS.md（对 codex 命令只读，每次启动按实际可写目录重写）；
  // 工作区只放一份占位说明（不存在或是未修改的旧模板时写入）
  const writableRoots = effectiveWritableRoots(process.env, cfg.CODEX_WRITABLE_ROOTS);
  const agentsFile = await writeGlobalAgentsMd(cfg.codexHome, { dataDir: cfg.DATA_DIR, workspaceDir: cfg.WORKSPACE_DIR, writableRoots });
  log.info("wrote codex global AGENTS.md", { file: agentsFile, writable_roots: writableRoots });
  if (await ensureWorkspaceAgentsMd(cfg.WORKSPACE_DIR)) log.info("wrote workspace AGENTS.md stub", { dir: cfg.WORKSPACE_DIR });
  // v2 的系统提示 ${DATA_DIR}/prompts/system.md 已弃用（规则分流不经模型）：存在时记一行弃用日志，不删除
  warnDeprecatedSystemPrompt(cfg.DATA_DIR);
  await new PiPromptLoader(cfg.DATA_DIR).read();

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
  const imageBackend = createImageBackend({
    mode: cfg.COMFY_MODE,
    comfyUrl: cfg.COMFY_MODE === "mcp" ? (comfyProxy?.url ?? cfg.COMFYUI_URL) : cfg.COMFYUI_URL,
    mcpBin: cfg.COMFY_MCP_BIN,
    comfyBin: cfg.COMFY_BIN,
    timeoutMs: cfg.COMFY_TIMEOUT_SEC * 1000,
    checkpoint: cfg.COMFY_CHECKPOINT || undefined,
    workflowFile: cfg.COMFY_WORKFLOW_FILE || undefined,
    promptNode: cfg.COMFY_PROMPT_NODE || undefined,
  });
  const codex = new CodexRunner({
    command: [cfg.CODEX_BIN],
    codexHome: cfg.codexHome,
    workspaceDir: cfg.WORKSPACE_DIR,
    threadsFile: path.join(cfg.DATA_DIR, "codex-threads.json"),
    legacySessionFile: path.join(cfg.DATA_DIR, "codex-session.json"),
    sandbox: cfg.CODEX_SANDBOX,
    timeoutMs: cfg.CODEX_TIMEOUT_SEC * 1000,
    rolloutMaxMb: cfg.CODEX_ROLLOUT_MAX_MB,
    threadMaxDays: cfg.CODEX_THREAD_MAX_DAYS,
  });

  const models = createAgentModels(cfg.codexHome);
  const agentModel = models.getModel(cfg.AGENT_MODEL_PROVIDER, cfg.AGENT_MODEL_ID);
  if (!agentModel) {
    throw new Error(`未知模型 ${cfg.AGENT_MODEL_PROVIDER}/${cfg.AGENT_MODEL_ID}`);
  }
  // 模型不支持所配置的思考档位时就近取支持的档位（衰老任务与 pi 后端用）
  const thinkingLevel = resolveThinkingLevel(agentModel, cfg.AGENT_THINKING_LEVEL);
  if (thinkingLevel !== cfg.AGENT_THINKING_LEVEL) {
    log.warn("AGENT_THINKING_LEVEL not supported by model, adjusted", {
      model: `${cfg.AGENT_MODEL_PROVIDER}/${cfg.AGENT_MODEL_ID}`,
      configured: cfg.AGENT_THINKING_LEVEL,
      effective: thinkingLevel,
    });
  }

  const pi = await PiBackend.open({
    dataDir: cfg.DATA_DIR, models, model: { provider: cfg.AGENT_MODEL_PROVIDER, modelId: cfg.AGENT_MODEL_ID },
    thinkingLevel, store, imageBackend, timeoutMs: cfg.PI_TURN_TIMEOUT_SEC * 1000,
    reserveTokens: cfg.PI_COMPACTION_RESERVE_TOKENS, backgroundTokens: cfg.PI_COMPACTION_BACKGROUND_TOKENS,
    maxContextChars: cfg.QQ_CONTEXT_MAX_CHARS,
  });
  // 执行 agent 后端（§4.3）：codex（默认）与 pi 长期会话。
  const backends = createBackendSelector({
    defaultBackend: cfg.AGENT_BACKEND,
    overrides: cfg.backendOverrides,
    backends: {
      codex: new CodexBackend({ runner: codex, imagesDir: cfg.imagesDir, ticketsDir: cfg.ticketsDir, reasoningEffort: cfg.CODEX_REASONING_EFFORT }),
      pi,
    },
  });
  const tasks = createTasks({
    getBridge,
    imageBackend,
    imagesDir: cfg.imagesDir,
    ticketsDir: cfg.ticketsDir,
    imageTimeoutCapMs: cfg.COMFY_TIMEOUT_SEC * 1000,
    imageCollectExtensions: cfg.IMAGE_COLLECT_EXTENSIONS,
    backends,
    owner: cfg.owner,
    store,
    codexReplyMode: cfg.CODEX_REPLY_MODE,
    models,
    relayModel: agentModel,
  });
  const extension = createCsAgentExtension(tasks);
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
    incomingDownloadConcurrency: cfg.INCOMING_DOWNLOAD_CONCURRENCY,
    incomingDownloadDeadlineMs: cfg.INCOMING_DOWNLOAD_DEADLINE_SEC * 1000,
  });

  const dispatcher = new Dispatcher({
    harness,
    bridge,
    tasks,
    concurrency: cfg.AGENT_CONCURRENCY,
    imagePrefixes: cfg.imagePrefixes,
    codexEffort: cfg.CODEX_REASONING_EFFORT,
    history: store,
  });

  // 聊天记录衰老（日/周摘要 + 清理）：每天 HISTORY_SUMMARY_HOUR 点（容器本地时区，默认 UTC）；启动时补跑
  const aging = startAgingScheduler({
    store,
    models,
    model: agentModel,
    rawDays: cfg.HISTORY_RAW_DAYS,
    summaryDays: cfg.HISTORY_SUMMARY_DAYS,
    rawHardMaxDays: cfg.HISTORY_RAW_HARD_MAX_DAYS,
    hour: cfg.HISTORY_SUMMARY_HOUR,
    cleanup: () => cleanupIncoming(cfg.DATA_DIR),
  });

  // 继续上次未完成的工作：先由派发器按 scope FIFO 接管索引中的票据（v2 遗留会话先中止），再开启任务调度。
  // 运行中的任务从最后提交的检查点继续（已完成的阶段不重跑）。
  await dispatcher.recover();
  harness.resume();

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
      checks.comfy = { ok: true, backend: info.backend, server: info.server, comfy_target: info.comfy_target, comfyui_version: info.comfyui_version, transparent: info.transparent };
      log.info("comfy self-check ok", { info });
    })
    .catch((err) => {
      checks.comfy = { ok: false, error: (err as Error).message };
      log.warn("comfy self-check failed", { error: err });
    });
  codex
    .readThreadIds()
    .then(async (threads) => {
      const { access } = await import("node:fs/promises");
      const authOk = await access(path.join(cfg.codexHome, "auth.json")).then(() => true, () => false);
      checks.codex = { ok: authOk, auth_json: authOk, threads };
    })
    .catch((err) => (checks.codex = { ok: false, error: (err as Error).message }));

  const server: Server = createServer(async (req, res) => {
    if (req.url !== "/healthz") {
      res.writeHead(404).end();
      return;
    }
    const st = bridge!.status();
    // 线程 id 会在运行中新建/轮换：每次请求现读 codex-threads.json
    const codexCheck =
      checks.codex && typeof checks.codex === "object" && "threads" in checks.codex
        ? { ...checks.codex, threads: await codex.readThreadIds().catch(() => null) }
        : checks.codex;
    const body = { ok: st.ws_connected, ws_connected: st.ws_connected, bridge: st, ...checks, codex: codexCheck,
      pi: { threads: await pi.readThreadIds().catch(() => null) } };
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
    await pi.close().catch(() => undefined);
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

import { loadCodexModelCatalog, loadCodexModelValidator } from "./agent/codex/model-catalog.js";
import { MediaRecall } from "./context/media.js";
import { RecallTokens, startMediaRecallServer } from "./context/media-recall-server.js";
import { ContextUsageStore } from "./agent/context-usage.js";
import { loadObsToken, publicHealth } from "./obs/token.js";
import { MemoryInstrumentation, purgeMemoryInstrumentation } from "./obs/memory/instrumentation.js";
import { ObsStore } from "./obs/store.js";
import { trace } from "./shared/trace.js";
import { Metrics, type Gauge } from "./obs/metrics.js";
import { createDashboard } from "./obs/http.js";
import { LiveBus } from "./obs/live.js";
import { startAlerts } from "./obs/alerts.js";
import { registerSecrets, redact, redactText } from "./shared/redact.js";
import { cleanupIncoming } from "./qq/incoming.js";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { applyEnvAliases, requireProviderApiKey, type Config } from "./config.js";
import { loadAgentConfig as loadConfig } from "./agent/config.js";
import { log, setLogLevel } from "./shared/log.js";
import { findUnwritable, processIdentity } from "./fs-check.js";
import { createQQBridge } from "./qq/index.js";
import { GrantsService } from "./agent/grants.js";
import type { Harness } from "@earendil-works/pi-durable";
import { SendService } from "./agent/send-service.js";
import type { Channel } from "./channel/types.js";
import { createAgentModels, openHarness, piModelCatalog, resolveThinkingLevel } from "./agent/harness.js";
import { createCsAgentExtension } from "./agent/extension.js";
import { warnDeprecatedSystemPrompt } from "./agent/prompt.js";
import { PiPromptLoader } from "./agent/pi-tools/prompt.js";
import { SkillsLoader } from "./agent/pi-tools/skills.js";
import { SkillsStore } from "./agent/skills-store.js";
import { closeAgentHarnesses } from "./agent/shutdown.js";
import { Dispatcher } from "./agent/dispatch.js";
import { ScheduleService } from "./agent/schedule/service.js";
import { createScheduleTask } from "./agent/schedule/task.js";
import { createScheduledRuntime } from "./agent/schedule/run.js";
import type { ScheduledRunLauncher } from "./agent/schedule/types.js";
import { CodexRunner } from "./agent/codex/runner.js";
import { purgeCodexTrace } from "./agent/codex/trace.js";
import { purgeGeneratedImages } from "./agent/codex/generated-images.js";
import { CodexPromptStore } from "./agent/codex/prompt.js";
import { CodexBasePromptStore } from "./agent/codex/base-prompt.js";
import { createImageBackend } from "./media/gen/image-gen.js";
import { isLoopbackUrl, startLoopbackProxy } from "./agent/loopback-proxy.js";
import { createTasks } from "./agent/tasks.js";
import { CodexBackend } from "./agent/backends/codex.js";
import { createBackendSelector } from "./agent/backends/select.js";
import { PiBackend } from "./agent/backends/pi.js";
import { ContextStore } from "./context/store.js";
import { SettingsStore, settingsDefaults } from "./agent/settings.js";
import { msUntilNextRun, startAgingScheduler } from "./context/aging.js";

async function main(): Promise<void> {
  // DEEPSEEK_APIKEY 等别名 → pi-ai 读取的标准变量名（须在创建 models 之前）
  applyEnvAliases(process.env);
  const cfg = loadConfig();
  requireProviderApiKey(cfg.AGENT_MODEL_PROVIDER);
  setLogLevel(cfg.LOG_LEVEL);
  try { cfg.OBS_TOKEN = await loadObsToken(cfg.DATA_DIR, cfg.OBS_TOKEN, message => log.info(message)); }
  catch { log.warn("observability token unavailable; dashboard access disabled"); }
  registerSecrets([cfg.OBS_TOKEN, cfg.NAPCAT_TOKEN, cfg.CODEX_MAGPIE_KEY]);
  const ctx = BACKGROUND_CONTEXT;
  log.info("starting cs-agent", {
    provider: cfg.AGENT_MODEL_PROVIDER,
    model: cfg.AGENT_MODEL_ID,
    comfy_mode: cfg.COMFY_MODE,
    data_dir: cfg.DATA_DIR,
    agent_backend: cfg.AGENT_BACKEND,
    backend_overrides: cfg.backendOverrides,
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

  // codex 全局行为指引来自 prompts/codex.md；实际权限规则由 runner 每轮写入会话域 AGENTS.md。
  // 父工作区的运维 AGENTS.md 保留，runner 拼入每个子工作区的受管规则。
  const writableRoots: string[] = []; // 实际可写目录由 runner 每轮按会话权限计算。
  const codexPrompt = new CodexPromptStore({ codexHome: cfg.codexHome, dataDir: cfg.DATA_DIR,
    workspaceDir: cfg.WORKSPACE_DIR, writableRoots, containsSecret: text => redactText(text, Number.MAX_SAFE_INTEGER) !== text });
  const codexBasePrompt = new CodexBasePromptStore({ codexHome: cfg.codexHome, dataDir: cfg.DATA_DIR,
    ...(cfg.CODEX_PROVIDER === "magpie" ? { magpieUrl: cfg.CODEX_MAGPIE_URL, magpieKey: cfg.CODEX_MAGPIE_KEY } : {}),
    containsSecret: text => redactText(text, Number.MAX_SAFE_INTEGER) !== text });
  await codexPrompt.read();
  await codexPrompt.regenerate();
  log.info("wrote codex global AGENTS.md", { file: codexPrompt.agentsFile, writable_roots: writableRoots });
  // v2 的系统提示 ${DATA_DIR}/prompts/system.md 已弃用（规则分流不经模型）：存在时记一行弃用日志，不删除
  warnDeprecatedSystemPrompt(cfg.DATA_DIR);
  await new PiPromptLoader(cfg.DATA_DIR).read();

  // 统一上下文消息库（${DATA_DIR}/qq-messages.sqlite）：意图层与 codex 的 qq_context MCP 共用
  const store = new ContextStore(cfg.DATA_DIR);
  const obs = new ObsStore(cfg.DATA_DIR, cfg.OBS_TICKET_EVENT_CAP, cfg.OBS_ADMIN_RETENTION_DAYS);
  trace.attach(obs);
  const instrumentation = obs.degraded ? undefined : MemoryInstrumentation.fromDb(obs.db);
  const contextUsage = new ContextUsageStore(cfg.DATA_DIR);
  // 进行中会话的实时总线：在派发器开始产生事件之前订阅 trace（/live 的 SSE 数据源）
  const live = new LiveBus(trace);
  if (obs.degraded) log.warn("observability storage degraded; agent continues");
  let bridge: Channel | undefined;
  const getBridge = () => {
    if (!bridge) throw new Error("QQBridge 未就绪");
    return bridge;
  };

  const mediaRecall = new MediaRecall({ store, dataDir: cfg.DATA_DIR,
    channel: {
      get outbox() { return getBridge().outbox; },
      fetchMessage: (messageId, opts) => getBridge().fetchMessage(messageId, opts),
      refreshImageUrl: (file, opts) => getBridge().refreshImageUrl(file, opts),
      getTicket: ticket => getBridge().getTicket(ticket),
    } });
  const chatsChannel: Pick<Channel, "listChats"> = { listChats: opts => getBridge().listChats(opts) };
  let dispatchHarness: Harness;
  const grants = new GrantsService({ getHarness: () => dispatchHarness, getChannel: getBridge, owner: cfg.owner });
  const sendService = new SendService({ grants, getChannel: getBridge, dataDir: cfg.DATA_DIR, store,
    limits: { maxBytes: cfg.ATTACH_FILE_MAX_MB * 1024 * 1024, maxFiles: cfg.ATTACH_FILES_MAX, denyExtensions: cfg.ATTACH_FILE_DENY_EXT } });
  const recallTokens = new RecallTokens(mediaRecall, cfg.MEDIA_RECALL_MAX_PER_TICKET, chatsChannel, {
    permissions: binding => grants.permissions(binding),
    auth: (binding, name, args) => grants.tool(binding, name, args),
    send: (binding, attempt, args, signal) => sendService.send({
      ticket: binding.ticket, source: binding.source, actor: binding.actor, actorIsOwner: binding.actorIsOwner, access: binding.access, workdir: binding.workdir!,
      extraRoots: [path.join(cfg.imagesDir, binding.ticket),
        ...(/^[0-9a-f-]{36}$/i.test(binding.session ?? "") ? [path.join(cfg.codexHome, "generated_images", binding.session!)] : [])],
    }, args, { attempt }, signal),
    release: (ticket, attempt) => sendService.releaseAttempt(ticket, attempt),
  });
  const recallServer = await startMediaRecallServer(recallTokens, cfg.MEDIA_RECALL_PORT);

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
    provider: cfg.CODEX_PROVIDER, magpieKey: cfg.CODEX_MAGPIE_KEY,
    imageGen: cfg.CODEX_IMAGE_GEN,
    recallTokens, mediaRecallPort: recallServer.port,
    contextUsage, model: cfg.CODEX_MODEL, contextWindow: cfg.CODEX_CONTEXT_WINDOW,
    codexHome: cfg.codexHome,
    workspaceDir: cfg.WORKSPACE_DIR,
    threadsFile: path.join(cfg.DATA_DIR, "codex-threads.json"),
    legacySessionFile: path.join(cfg.DATA_DIR, "codex-session.json"),
    sandbox: cfg.CODEX_SANDBOX,
    sandboxNetwork: cfg.CODEX_SANDBOX_NETWORK,
    preparePrompt: () => codexPrompt.regenerate(),
    prepareBasePrompt: model => codexBasePrompt.prepare(model),
    timeoutMs: cfg.CODEX_TIMEOUT_SEC * 1000,
    closeGraceMs: cfg.CODEX_CLOSE_GRACE_MS,
    exitGraceMs: cfg.CODEX_EXIT_GRACE_MS,
    rolloutMaxMb: cfg.CODEX_ROLLOUT_MAX_MB,
    threadMaxDays: cfg.CODEX_THREAD_MAX_DAYS,
    traceRetentionDays: cfg.CODEX_TRACE_RETENTION_DAYS,
  });

  // 存储加载后先恢复历史占用；codex 初始化与 PiBackend.open 均完成后才开放面板。
  await codex.initializeContextUsage();
  const magpie = cfg.AGENT_MODEL_PROVIDER === "magpie" ? { baseUrl: cfg.CODEX_MAGPIE_URL, apiKey: cfg.CODEX_MAGPIE_KEY } : undefined;
  const models = await createAgentModels(cfg.codexHome, magpie);
  if (magpie) log.info("pi models via magpie", { base_url: magpie.baseUrl, models: models.getModels("magpie").length });
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

  // 模型目录就绪后注入校验器；.env 为默认，settings.json 覆盖。
  const settings = await SettingsStore.open(cfg.DATA_DIR, settingsDefaults(cfg), trace, {
    codexModel: await loadCodexModelValidator(path.join(cfg.codexHome, "models_cache.json")),
    piModel: id => !!models.getModel(cfg.AGENT_MODEL_PROVIDER, id),
  });
  // 设置页下拉清单：启动读一次（与校验器同源），重启后更新。
  const codexCatalog = await loadCodexModelCatalog(path.join(cfg.codexHome, "models_cache.json"));
  const piCatalog = piModelCatalog(models, cfg.AGENT_MODEL_PROVIDER);
  const modelCatalog = { codex: () => codexCatalog, pi: () => piCatalog };
  log.info("runtime settings loaded", { ...settings.current() });
  const currentPiModel = () => ({ provider: cfg.AGENT_MODEL_PROVIDER, modelId: settings.current().piModel });
  const autoModel = cfg.AUTO_EFFORT_MODEL ? models.getModel("magpie", cfg.AUTO_EFFORT_MODEL) : undefined;
  if (cfg.AUTO_EFFORT_MODEL && !autoModel) log.warn("auto effort model unavailable; using heuristics and fallback", { model: cfg.AUTO_EFFORT_MODEL });

  // 执行 agent 后端（§4.3）：codex（默认）与 pi 长期会话。
  const backends = createBackendSelector({
    current: () => settings.current(),
    backends: {
      codex: new CodexBackend({ runner: codex, imagesDir: cfg.imagesDir, ticketsDir: cfg.ticketsDir, reasoningEffort: cfg.CODEX_REASONING_EFFORT }),
      pi: { name: "pi", handle: (req, context) => pi.handle(req, context), recordDeliveryNote: note => pi.recordDeliveryNote(note) },
    },
  });
  const tasks = createTasks({
    sendService,
    getBridge,
    imageBackend,
    imagesDir: cfg.imagesDir,
    ticketsDir: cfg.ticketsDir,
    imageTimeoutCapMs: cfg.COMFY_TIMEOUT_SEC * 1000,
    imageCollectExtensions: cfg.IMAGE_COLLECT_EXTENSIONS,
    backends,
    owner: cfg.owner,
    store,
    currentSettings: () => settings.currentForTurn(),
    codexReasoningEffort: cfg.CODEX_REASONING_EFFORT, piThinkingLevel: cfg.AGENT_THINKING_LEVEL,
    effortRouter: { model: cfg.AUTO_EFFORT_MODEL, timeoutMs: cfg.AUTO_EFFORT_TIMEOUT_MS,
      ...(autoModel ? { complete: async (prompt: string, signal: AbortSignal) => {
        const result = await models.completeSimple(autoModel,
          { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
          // pi-ai 的 simple 接口用 undefined 表示 off（thinkingLevel 仅用于 durable agent）。
          { signal, reasoning: undefined, maxTokens: 8 });
        if (result.stopReason === "error" || result.stopReason === "aborted") throw new Error("分类模型失败");
        return result.content.map(c => c.type === "text" ? c.text : "").join("");
      } } : {}),
    },
  });
  // 回调仅在恢复/调度后调用；先注册两类任务，再补齐服务与派发器，避免构造环。
  let schedules: ScheduleService;
  const canSchedule = grants.canSchedule.bind(grants);
  const scheduled = createScheduledRuntime({
    getChannel: getBridge, tasks, owner: cfg.owner, canSchedule,
    recorder: { recordRun: (id, run) => schedules.recordRun(id, run) },
    pauseSchedule: (id, reason) => schedules.pauseWithReason(id, reason),
  });
  const scheduledAdmitter: ScheduledRunLauncher = {
    prepare: scheduled.prepare,
    dispatchScheduled: ticket => { void dispatcher.dispatchScheduled(ticket); },
  };
  const scheduleTask = createScheduleTask({ admitter: scheduledAdmitter });
  const extension = createCsAgentExtension(tasks, [scheduleTask, scheduled.ScheduledTask]);
  const harness = dispatchHarness = await openHarness({ models, extension, dbFile: path.join(cfg.DATA_DIR, "agent.sqlite") }, ctx);
  schedules = new ScheduleService({ harness, task: scheduleTask, admitter: scheduledAdmitter, owner: cfg.owner, canSchedule });

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

  // 恢复 pi 工具前，派发授权文档与 Channel 必须已就绪。
  const pi = await PiBackend.open({
    sendService, grants,
    currentModel: currentPiModel,
    dataDir: cfg.DATA_DIR, workspaceDir: cfg.WORKSPACE_DIR, models, model: { provider: cfg.AGENT_MODEL_PROVIDER, modelId: cfg.AGENT_MODEL_ID },
    skillsDir: cfg.PI_SKILLS_DIR,
    channel: chatsChannel, mediaRecall, mediaRecallMaxPerTicket: cfg.MEDIA_RECALL_MAX_PER_TICKET,
    thinkingLevel, store, instrumentation, contextUsage, imageBackend, timeoutMs: cfg.PI_TURN_TIMEOUT_SEC * 1000,
    reserveTokens: cfg.PI_COMPACTION_RESERVE_TOKENS, backgroundTokens: cfg.PI_COMPACTION_BACKGROUND_TOKENS,
    maxContextChars: cfg.QQ_CONTEXT_MAX_CHARS,
    attachmentLimits: { maxBytes: cfg.ATTACH_FILE_MAX_MB * 1024 * 1024, maxFiles: cfg.ATTACH_FILES_MAX, denyExtensions: cfg.ATTACH_FILE_DENY_EXT },
  });
  const dispatcher = new Dispatcher({
    harness, scheduled,
    bridge,
    tasks,
    concurrency: cfg.AGENT_CONCURRENCY,
    imagePrefixes: cfg.imagePrefixes,
    history: store,
  });

  // 聊天记录衰老（日/周摘要 + 清理）：每天 HISTORY_SUMMARY_HOUR 点（容器本地时区，默认 UTC）；启动时补跑
  const aging = startAgingScheduler({
    store, instrumentation,
    models,
    model: () => { const ref = currentPiModel(); return models.getModel(ref.provider, ref.modelId) ?? agentModel; },
    rawDays: cfg.HISTORY_RAW_DAYS,
    summaryDays: cfg.HISTORY_SUMMARY_DAYS,
    rawHardMaxDays: cfg.HISTORY_RAW_HARD_MAX_DAYS,
    hour: cfg.HISTORY_SUMMARY_HOUR,
    cleanup: () => cleanupIncoming(cfg.DATA_DIR),
  });

  // 继续上次未完成的工作：先由派发器按 scope FIFO 接管索引中的票据（v2 遗留会话先中止），再开启任务调度。
  // 运行中的任务从最后提交的检查点继续（已完成的阶段不重跑）。
  const alerts = startAlerts({ enabled: () => settings.current().alertOwner, owner: cfg.owner, bridge, trace });
  await dispatcher.recover();
  await schedules.start();
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
      if (cfg.CODEX_PROVIDER === "magpie") {
        checks.codex = { ok: true, provider: "magpie", key_present: !!cfg.CODEX_MAGPIE_KEY, threads };
        return;
      }
      const { access } = await import("node:fs/promises");
      const authOk = await access(path.join(cfg.codexHome, "auth.json")).then(() => true, () => false);
      checks.codex = { ok: authOk, auth_json: authOk, threads };
    })
    .catch((err) => (checks.codex = { ok: false, error: (err as Error).message }));

  const codexStatus = async () => {
    const threads = await codex.readThreadIds();
    return Promise.all(Object.entries(threads).map(async ([key, id]) => ({ thread_key: key, thread_id: id,
      rollout_bytes: id ? await codex.rolloutSize(id) ?? null : null,
      observed_turns: obs.degraded ? 0 : (obs.db.prepare("SELECT COUNT(*) n FROM events WHERE stage='model_turn' AND status='ok' AND json_extract(detail_json,'$.backend')='codex' AND json_extract(detail_json,'$.thread_key')=?").get(key) as {n:number}).n })));
  };
  const piStatus = async () => ({ threads: await pi.readThreadIds(), ...await pi.threadHealth(),
    compaction: obs.degraded ? [] : obs.db.prepare("SELECT json_extract(detail_json,'$.conversation') conversation, COUNT(*) attempts, MAX(ts) last_at FROM events WHERE stage='compaction' GROUP BY conversation").all(),
    usage: await pi.harness.usage(ctx), compaction_policy: { reserveTokens: cfg.PI_COMPACTION_RESERVE_TOKENS, backgroundTokens: cfg.PI_COMPACTION_BACKGROUND_TOKENS } });
  const skills = cfg.PI_SKILLS_DIR === "off" ? undefined : new SkillsStore({ dir: cfg.PI_SKILLS_DIR, loader: new SkillsLoader({ dir: cfg.PI_SKILLS_DIR }) });
  const dashboardData = { contextUsage, codexPrompt, codexBasePrompt, modelCatalog, skills };
  const dashboard = createDashboard({
    grants, schedules, ...dashboardData, config: cfg, store: obs, context: store, queue: () => dispatcher.status(),
    health: () => ({ degraded: obs.degraded || !cfg.OBS_TOKEN, bridge: bridge!.status(), ...checks, deepseek_key_present: !!(process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_APIKEY),
      aging: obs.latest("aging") ?? { last_run: store.getMeta("aging_last_run") ?? null }, dropped_events: trace.dropped }),
    codex: codexStatus, pi: piStatus, piSessions: pi.sessionSource, settings, live,
    aging: { running: aging.running, nextRun: () => { const now = Date.now(); return now + msUntilNextRun(cfg.HISTORY_SUMMARY_HOUR, now); },
      config: { rawDays: cfg.HISTORY_RAW_DAYS, summaryDays: cfg.HISTORY_SUMMARY_DAYS, hardMaxDays: cfg.HISTORY_RAW_HARD_MAX_DAYS,
        dailyHour: cfg.HISTORY_SUMMARY_HOUR, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } },
    archives: { codex: path.join(cfg.DATA_DIR, 'codex-threads-archive.jsonl'), pi: path.join(cfg.DATA_DIR, 'pi-threads-archive.jsonl') },
    resetCodex: (key) => codex.resetThread(key), resetPi: (key) => pi.resetThread(key),
    compactCodex: (key) => codex.compactThread(key, "dashboard", settings.currentForTurn().codexModel), compactPi: (key) => pi.compactThread(key) });
  const metrics = new Metrics(obs, { retentionDays: cfg.OBS_RETENTION_DAYS, inputPrice: cfg.DEEPSEEK_PRICE_IN_PER_M, outputPrice: cfg.DEEPSEEK_PRICE_OUT_PER_M,
    onPurge: async now => {
      try { if (!obs.degraded) purgeMemoryInstrumentation(obs.db, cfg.OBS_MEMORY_RETENTION_DAYS, now); }
      catch (error) { log.warn("memory instrumentation purge failed", { error }); }
      await purgeCodexTrace(cfg.codexHome, cfg.CODEX_TRACE_RETENTION_DAYS, now, cfg.CODEX_TRACE_MAX_MB)
        .catch(error => { log.warn("codex trace purge failed", { error }); });
      await purgeGeneratedImages(cfg.codexHome, cfg.CODEX_GENERATED_IMAGES_RETENTION_DAYS, now, cfg.CODEX_GENERATED_IMAGES_MAX_MB)
        .then(({ removed, bytes, dirs }) => { if (removed > 0) log.info("codex generated images purged", { removed, bytes, dirs }); })
        .catch(error => { log.warn("codex generated images purge failed", { error }); });
    },
    gauges: async () => {
      const q = dispatcher.status(), ws = bridge!.status();
      const gauges: Gauge[] = [ { name: "queue_depth", value: q.waiting }, { name: "global_slots_used", value: q.active },
        { name: "global_slots", value: q.slots }, { name: "ws_connected", value: Number(ws.ws_connected) },
        { name: "ws_disconnect_count", value: ws.disconnect_count }, { name: "pi_conversations", value: (await pi.threadHealth()).count } ];
      for (const [scope, depth] of Object.entries(q.scopes)) gauges.push({ name: "scope_queue_depth", labels: { scope }, value: depth });
      for (const t of await codexStatus()) {
        gauges.push({ name: "codex_thread_present", labels: { thread_key: t.thread_key }, value: Number(!!t.thread_id) });
        gauges.push({ name: "codex_observed_turns", labels: { thread_key: t.thread_key }, value: t.observed_turns });
        if(t.rollout_bytes !== null) gauges.push({ name: "codex_rollout_bytes", labels: { thread_key: t.thread_key }, value: t.rollout_bytes });
      }
      const aging = obs.latest("aging");
      if (aging) gauges.push({ name: "aging_last_success", value: Number(aging.status === "ok") }, { name: "aging_last_run_ms", value: aging.ts });
      return gauges;
    } });
  metrics.start();
  const server: Server = createServer(async (req, res) => {
    if (req.url !== "/healthz") {
      await dashboard.handle(req, res);
      return;
    }
    const st = bridge!.status();
    // 线程 id 会在运行中新建/轮换：每次请求现读 codex-threads.json
    const codexCheck =
      checks.codex && typeof checks.codex === "object" && "threads" in checks.codex
        ? { ...checks.codex, threads: await codex.readThreadIds().catch(() => null) }
        : checks.codex;
    const body = publicHealth({ connected: st.ws_connected, degraded: obs.degraded || !cfg.OBS_TOKEN,
      comfy: checks.comfy, codex: codexCheck, threads: await codex.readThreadIds().catch(() => null),
      pi: await pi.threadHealth().catch(() => null) });
    // 每条记录单独脱敏，避免通用脱敏器的数组上限截断超过 100 个 pi 会话。
    const health = { ...redact(body, 20_000) as Record<string, unknown>,
      context_usage: contextUsage.all().map(usage => redact(usage, 20_000)) };
    res.writeHead(st.ws_connected ? 200 : 503, { "Content-Type": "application/json" }).end(JSON.stringify(health));
  });
  server.listen(cfg.HEALTH_PORT, cfg.HEALTH_HOST, () => log.info("healthz listening", { port: cfg.HEALTH_PORT }));

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("shutting down", { signal });
    const force = setTimeout(() => process.exit(1), 20_000);
    force.unref();
    await dashboard.close();
    live.close();
    server.close();
    alerts.stop();
    aging.stop();
    schedules.stop();
    await recallServer.close();
    await bridge!.stop().catch(() => undefined);
    await closeAgentHarnesses(harness, pi);
    await contextUsage.close().catch(() => log.warn("context usage shutdown flush failed"));
    try {
      store.close();
    } catch {
      /* ignore */
    }
    await metrics.stop().catch(() => undefined);
    trace.attach(undefined);
    obs.close();
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

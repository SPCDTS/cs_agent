import { assertNoCredentials, fingerprint, type AgentMessage, type AgentReceipt, type AgentSend } from "../communication/model";
import { importFiles, incomingText, proves, sendAgent, verifyMessage } from "../communication/service";
import { agentSendTool } from "../communication/tool";
import type { SubagentReport } from "./model";
import { workspaceExecutionEnv } from "../sandbox/execution-env";
import { ProjectionPublisher, observeWrites } from "../requests/projection";
import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import { createRegistry, defineExtension, defineTool, GenerationTask, Harness, hook, LiveDoc, section, type Conversation, type EntryId } from "@earendil-works/pi-durable";
import { DurableObjectSqliteDatabase, openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import type { Env } from "../env";
import { ModelAlarm, loadProviderCatalogs, modelChange, openModels, remoteCredentials, usesDynamicCatalog, type ProviderCatalogs } from "../models";
import { captureModels } from "../requests/capture";
import { requestTrace } from "../requests/trace";
import { contextSource } from "../requests/context-source";
import { createWebPageTool } from "../tools/web-page";
import { QQ_CONTEXT_DESCRIPTION, QQ_CONTEXT_PARAMETERS } from "../context";
import { memoryDescriptions, memoryParameters } from "../memory/contracts";
import { formatBeijingTime } from "../memory/time";
import { PI_SAFETY_RULE, WEB_RULE } from "../prompt";
import { stripProviderMarkup } from "../send-clean";
import { classifyError, logDiag } from "../shared/diagnostics";
import { createSubagentCapabilityHost, installDelegatedCapabilities } from "../mcp/delegated";
import { RETENTION_MS, subagentName, type SubagentMeta, type SubagentStart, type SubagentState } from "./model";
import { responseDescription, shortSummary, subagentActivity, SUBAGENT_PROGRESS_RULE } from "./activity";

const context = BACKGROUND_CONTEXT;
// 有未完成的工作时定期自唤醒：驱逐后由 alarm 重新打开 Harness 续跑，并补送没送到父线程的汇报。
const HEARTBEAT_MS = 60_000;
const SUBAGENT_RULE = "你是主 agent 派出的子 agent，只负责完成交给你的任务。你不能联系用户、写记忆或安排定时；可用 agent_send 与已授权 Agent 通信；把最终结果完整写在回答里，它会原样交回主 agent。qq_context 与 mem_search 只读派出你的会话。获授权时可通过 Code Mode 使用分配的 Cloudflare 工作区和 MCP 工具。结束前整理需要保留的产物和内容。";

/** queued → running → answered（回答已落库）→ reported（父线程已收下）；cancelled 是取消或父关系永久撤销后退休的项。 */
type InboxStatus = "queued" | "running" | "answered" | "reported" | "cancelled";
type InboxRow = { request_id: string; text: string; received_at: number; status: InboxStatus; answer: string | null; outcome: "done" | "failed" | null };
type Runtime = { harness: Harness; root: Conversation };

const state = (meta: SubagentMeta): SubagentState => ({ status: meta.status, version: meta.version });

export class SubagentDO extends DurableObject<Env> {
  private readonly modelAlarm = new ModelAlarm(this.ctx);
  private readonly projection = new ProjectionPublisher(this.ctx, this.env, async () => { const meta = await this.meta(); return meta ? subagentName(meta.parent, meta.id) : ""; }, at => this.wakeBy(at));
  private readonly observedStorage = observeWrites(this.ctx.storage, () => this.projection.changed());
  private readonly database = new DurableObjectSqliteDatabase(this.observedStorage);
  private initialized?: Promise<void>;
  private catalogs: ProviderCatalogs = {};
  private runtime?: Promise<Runtime>;
  private draining?: Promise<void>;
  private dirty = false;
  private receiving: Promise<unknown> = Promise.resolve();

  private initialize(): Promise<void> {
    return this.initialized ??= this.database.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox (
        request_id TEXT PRIMARY KEY, text TEXT NOT NULL, received_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'answered', 'reported', 'cancelled')),
        answer TEXT, outcome TEXT CHECK (outcome IN ('done', 'failed'))
      );
    `).then(async () => {
      const columns = await this.database.all<{ name: string }>("PRAGMA table_info(inbox)");
      for (const name of ["agent_hash", "agent_files"]) if (!columns.some(c => c.name === name)) await this.database.exec("ALTER TABLE inbox ADD COLUMN " + name + " TEXT");
      this.projection.install();
    });
  }

  private async meta(): Promise<SubagentMeta | undefined> {
    await this.initialize();
    const row = await this.database.get<{ value: string }>("SELECT value FROM meta WHERE key = 'subagent'");
    return row ? JSON.parse(row.value) as SubagentMeta : undefined;
  }

  /**
   * 改 meta 的唯一入口：change 返回 true 时推进版本。每次都按结果重排 alarm：
   * 还有工作（运行中，或有已回答未送达的汇报）就心跳，否则在结束 14 天后删除。
   */
  private update(change: (meta: SubagentMeta, tx: SqliteExecutor) => Promise<boolean>): Promise<SubagentMeta> {
    return this.database.transaction(async tx => {
      const row = await tx.get<{ value: string }>("SELECT value FROM meta WHERE key = 'subagent'");
      if (!row) throw new Error("subagent_missing");
      const meta = JSON.parse(row.value) as SubagentMeta;
      const before = JSON.stringify([meta.status, meta.progress]);
      let activityChanged = false;
      if (await change(meta, tx)) {
        meta.version++;
        activityChanged = before !== JSON.stringify([meta.status, meta.progress]);
        if (activityChanged) meta.activityAt = Date.now();
        await tx.run("UPDATE meta SET value = ? WHERE key = 'subagent'", JSON.stringify(meta));
      }
      const pending = meta.status === "running" || meta.status !== "cancelled" && !!await tx.get("SELECT 1 FROM inbox WHERE status = 'answered' LIMIT 1");
      const next = Math.min(pending ? Date.now() + HEARTBEAT_MS : (meta.endedAt ?? meta.createdAt) + RETENTION_MS,
        this.modelAlarm.pending ? Date.now() : Infinity, this.projection.retryAt ?? Infinity);
      if (pending) await this.wakeBy(next);
      else await this.ctx.storage.setAlarm(next);
      return { meta, activityChanged };
    }).then(({ meta, activityChanged }) => {
      if (activityChanged) this.publishActivity(meta);
      return meta;
    });
  }

  private publishActivity(meta: SubagentMeta): void {
    this.ctx.waitUntil(this.env.REQUESTS.getByName("main").recordAgent(subagentActivity(meta)).catch(error => {
      console.error({ event: "subagent_activity_failed", thread: meta.parent, actor: meta.id, ...classifyError(error) });
    }));
  }

  /** 幂等：已存在时只返回当前状态。 */
  async start(init: SubagentStart): Promise<SubagentState> {
    // 名称经绑定的 idFromName 复核，RPC 参数不能把别的父线程塞进这个对象。
    if (!this.ctx.id.equals(this.env.SUBAGENT.idFromName(subagentName(init.parent, init.id)))) throw new Error("subagent name mismatch");
    await this.initialize();
    const meta = await this.database.transaction(async tx => {
      const existing = await tx.get<{ value: string }>("SELECT value FROM meta WHERE key = 'subagent'");
      if (existing) return JSON.parse(existing.value) as SubagentMeta;
      const now = Date.now();
      const created: SubagentMeta = { ...init, summary: shortSummary(init.summary || init.task), createdAt: now, activityAt: now, status: "running", reportCount: 0, version: 1 };
      await tx.run("INSERT INTO meta (key, value) VALUES ('subagent', ?)", JSON.stringify(created));
      await tx.run("INSERT INTO inbox (request_id, text, received_at, status) VALUES ('task', ?, ?, 'queued')", init.task, now);
      await this.wakeBy(now);
      return created;
    });
    this.publishActivity(meta);
    return state(meta);
  }

  /** 同一 requestId 只收一次；已取消的不再接受，已结束的重新进入运行并保留之前的上下文。 */
  async message(requestId: string, text: string, communication?: { hash: string; files: string[] }): Promise<{ result: "accepted" | "duplicate" | "ended"; state: SubagentState }> {
    await this.initialize();
    let result = "duplicate" as "accepted" | "duplicate" | "ended";
    const meta = await this.update(async (meta, tx) => {
      if (meta.status === "cancelled") { result = "ended"; return false; }
      const previous = await tx.get<{ text: string; agent_hash: string | null }>("SELECT text,agent_hash FROM inbox WHERE request_id = ?", requestId);
      if (previous) {
        if (previous.text !== text || (previous.agent_hash ?? undefined) !== communication?.hash) throw new Error("agent_message_conflict");
        return false;
      }
      await tx.run("INSERT INTO inbox (request_id, text, received_at, status) VALUES (?, ?, ?, 'queued')", requestId, text, Date.now());
      if (communication) await tx.run("UPDATE inbox SET agent_hash=?,agent_files=? WHERE request_id=?", communication.hash, JSON.stringify(communication.files), requestId);
      result = "accepted";
      meta.status = "running";
      delete meta.progress;
      delete meta.endedAt;
      await this.wakeBy(Date.now());
      return true;
    });
    return { result, state: state(meta) };
  }


  async agentProof(id: string, hash: string): Promise<boolean> {
    const meta = await this.meta();
    return !!meta && meta.status !== "cancelled" && await this.env.THREAD.getByName(meta.parent).agentChildAllowed(meta.id) && proves(this.ctx.storage, id, hash, meta.createdAt);
  }
  agentReceive(message: AgentMessage): Promise<AgentReceipt> {
    // 串行查重/导入/入箱；同一对象内并发重放也不能重复导入附件。
    const receipt = this.receiving.then(() => this.receiveAgent(message));
    this.receiving = receipt.catch(() => {});
    return receipt;
  }
  private async receiveAgent(message: AgentMessage): Promise<AgentReceipt> {
    const meta = await this.meta();
    if (!meta || meta.status === "cancelled") throw new Error("agent_session_ended");
    if (message.report) throw new Error("agent_invalid_message");
    await verifyMessage(this.env, subagentName(meta.parent, meta.id), message);
    const parent = this.env.THREAD.getByName(meta.parent);
    const previous = await this.database.get<{ agent_hash: string | null; agent_files: string | null }>("SELECT agent_hash,agent_files FROM inbox WHERE request_id=?", message.id);
    if (previous) {
      if (previous.agent_hash !== fingerprint(message)) throw new Error("agent_message_conflict");
      // 回执丢失后仍补同步父状态，但不触碰接收方已编辑/删除的副本。
      await parent.agentChildWake(meta.id);
      return { messageId: message.id, status: "duplicate", files: JSON.parse(previous.agent_files ?? "[]") as string[] };
    }
    const paths = await importFiles(this.env, message, (path, bytes) => parent.subagentSaveAttachment(meta.id, path, bytes));
    const result = await this.message(message.id, incomingText(message, paths), { hash: fingerprint(message), files: paths });
    if (result.result === "ended") throw new Error("agent_session_ended");
    await parent.agentChildWake(meta.id);
    return { messageId: message.id, status: result.result, files: paths };
  }
  private async sendAgentMessage(args: AgentSend, seed: string, report?: SubagentReport): Promise<AgentReceipt> {
    const meta = await this.meta();
    if (!meta || meta.status === "cancelled") throw new Error("agent_session_ended");
    return sendAgent({ env: this.env, storage: this.ctx.storage, agentSessionId: subagentName(meta.parent, meta.id), generation: meta.createdAt,
      readFile: path => this.env.THREAD.getByName(meta.parent).subagentReadBlob(meta.id, path),
    }, args, seed, report);
  }

  /** 只取消运行中的；已回答未送达的汇报也不再补送。 */
  async cancel(): Promise<SubagentState> {
    await this.initialize();
    let changed = false;
    const meta = await this.update(async (meta, tx) => {
      if (meta.status !== "running") return false;
      await tx.run("UPDATE inbox SET status = 'cancelled' WHERE status IN ('queued', 'running')");
      meta.status = "cancelled";
      delete meta.progress;
      meta.endedAt = Date.now();
      return changed = true;
    });
    if (changed) {
      // 中止 API 也会隐式恢复 Harness；由 alarm 处理，避免取消请求成为模型执行入口。
      await this.database.transaction(() => this.wakeBy(Date.now()));
    }
    return state(meta);
  }

  async syncAdminView(): Promise<void> {
    await this.initialize();
    if (!await this.meta()) return;
    this.projection.install();
    await this.projection.flush();
    if (this.projection.retryAt !== undefined) throw new Error("view_sync_failed");
  }

  async status(): Promise<{ meta: SubagentMeta; inbox: Partial<Record<InboxStatus, number>> } | undefined> {
    const meta = await this.meta();
    if (!meta) return;
    const rows = await this.database.all<{ status: InboxStatus; n: number }>("SELECT status, COUNT(*) AS n FROM inbox GROUP BY status");
    return { meta, inbox: Object.fromEntries(rows.map(row => [row.status, row.n])) };
  }

  override async alarm(): Promise<void> {
    this.modelAlarm.dispatch();
    const meta = await this.meta();
    if (meta && Date.now() < (meta.endedAt ?? Infinity) + RETENTION_MS) {
      this.ctx.waitUntil(this.projection.flush());
      await this.update(async () => false);
      if (meta.status === "cancelled") {
        await (await this.open()).root.abort(context);
        return;
      }
      this.kick();
      return;
    }
    // 结束满 14 天（或从未启动）：整个对象连同 Pi 存储一起删除。
    const runtime = await this.runtime?.catch(() => undefined);
    await runtime?.harness.close(context).catch(() => {});
    await this.ctx.storage.deleteAlarm();
    this.projection.reset();
    await this.ctx.storage.deleteAll();
    this.initialized = this.runtime = undefined;
  }

  private async wakeBy(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  private kick(): void {
    this.dirty = true;
    this.draining ??= this.drain().finally(() => { this.draining = undefined; });
    this.ctx.waitUntil(this.draining);
  }

  private async drain(): Promise<void> {
    while (this.dirty) {
      this.dirty = false;
      try { while (await this.step()) { /* 逐项处理到没有可做的 */ } }
      catch (error) {
        // 汇报送不到或模型调用出错时停在原地，由心跳 alarm 重试。
        const meta = await this.meta().catch(() => undefined);
        logDiag(this.env, this.ctx, { event: "subagent_step_failed", thread: meta?.parent, actor: meta?.id, error });
        return;
      }
    }
  }

  /** 一次只跑一项输入，每项各得一个回答、各汇报一次；没有可做的返回 false。 */
  private async step(): Promise<boolean> {
    const meta = await this.meta();
    if (!meta) return false;
    if (meta.status === "cancelled") return false;
    const answered = await this.database.get<InboxRow>("SELECT * FROM inbox WHERE status = 'answered' ORDER BY received_at, rowid LIMIT 1");
    if (answered) {
      await this.report(meta, answered);
      return true;
    }
    if (meta.status !== "running") return false;
    const next = await this.database.get<InboxRow>(`SELECT * FROM inbox WHERE status IN ('running', 'queued')
      ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, received_at, rowid LIMIT 1`);
    if (!next) return false;
    if (this.runtime && usesDynamicCatalog(meta.model.provider)) await this.refreshCatalogs();
    await this.answer(next);
    return true;
  }

  private async answer(row: InboxRow): Promise<void> {
    if (row.status === "queued") await this.update(async meta => {
      if (!meta.progress) return false;
      delete meta.progress;
      return true;
    });
    await this.database.run("UPDATE inbox SET status = 'running' WHERE request_id = ? AND status = 'queued'", row.request_id);
    const { harness, root } = await this.open();
    // requestId 让驱逐后的重交找回同一提交，不会把同一条输入跑两遍。
    const settled = await (await root.submit({ type: "input", content: row.text, requestId: row.request_id, whenBusy: "followUp" }, context)).wait(context);
    const answer = settled.status === "done" && settled.type === "input" ? await this.answerText(harness, settled.answer) : undefined;
    const outcome = answer === undefined ? "failed" : "done";
    const text = answer === undefined ? `子 agent 没能给出回答（${settled.status === "unanswered" ? settled.reason : settled.status}）` : answer || "（没有文字回答）";
    await this.update(async (meta, tx) => {
      // 取消后迟到的回答既不落库也不汇报。
      if (meta.status === "cancelled") return false;
      await tx.run("UPDATE inbox SET status = 'answered', answer = ?, outcome = ? WHERE request_id = ? AND status = 'running'", text, outcome, row.request_id);
      if (await tx.get("SELECT 1 FROM inbox WHERE status IN ('queued', 'running') LIMIT 1")) return false;
      meta.status = outcome;
      if (outcome === "failed" || meta.progress?.kind !== "result") delete meta.progress;
      meta.endedAt = Date.now();
      return true;
    });
  }

  private async answerText(harness: Harness, answer: EntryId): Promise<string> {
    const entry = await harness.commit(tx => tx.entry(answer), context);
    return stripProviderMarkup((entry?.model ?? []).flatMap(message => message.role === "assistant"
      ? message.content.flatMap(block => block.type === "text" ? [block.text] : []) : []).join("")).trim().replace(/^【结果】\s*/u, "");
  }

  private async report(meta: SubagentMeta, row: InboxRow): Promise<void> {
    let text = row.answer ?? "", outcome = row.outcome ?? "failed";
    try { assertNoCredentials(text); }
    catch { text = "[agent_credentials_forbidden] 结果含凭据，已阻止原文回传。"; outcome = "failed"; }
    text = text.slice(0, 8000);
    try {
      await this.sendAgentMessage({ to: meta.parent, text: text || "（没有文字回答）" }, "report:" + row.request_id,
        { subagentId: meta.id, requestId: row.request_id, text, identity: meta.identity, outcome, state: state(meta) });
    } catch (error) {
      // 只有确证永久结束的关系退休；网络未知、临时失败保留 answered 重试。
      if (!(error instanceof Error) || !["agent_session_denied", "agent_session_revoked", "agent_session_ended"].includes(error.message)) throw error;
      await this.update(async (_meta, tx) => {
        await tx.run("UPDATE inbox SET status='cancelled' WHERE request_id=? AND status='answered'", row.request_id);
        return false;
      });
      logDiag(this.env, this.ctx, { event: "subagent_report_retired", thread: meta.parent, actor: meta.id, error: new Error(error.message) });
      return;
    }
    await this.update(async (meta, tx) => {
      await tx.run("UPDATE inbox SET status = 'reported' WHERE request_id = ? AND status = 'answered'", row.request_id);
      meta.reportCount++;
      return true;
    });
  }

  private async refreshCatalogs() {
    this.catalogs = await loadProviderCatalogs(this.env.REGISTRY.getByName("main"));
  }

  private open(): Promise<Runtime> {
    return this.runtime ??= this.openRuntime().catch(error => {
      this.runtime = undefined;
      throw error;
    });
  }

  private async openRuntime(): Promise<Runtime> {
    const meta = await this.meta();
    if (!meta) throw new Error("subagent_missing");
    const trace = requestTrace(this.env, this.ctx, meta.parent, async (api, callContext) => {
      const live = await api.snapshot(LiveDoc, api.conversationId, callContext), first = live?.run?.inputs[0], last = live?.run?.inputs.at(-1);
      if (!first || !last) return;
      const submission = await (await harness.submission(last, callContext))?.status(callContext);
      return submission?.requestId ? { turnId: "turn:sub:" + meta.id + ":" + first, inputId: submission.requestId, generation: 0 } : undefined;
    }, meta.id);
    const monitor = contextSource(this.ctx.storage, () => harness);
    if (usesDynamicCatalog(meta.model.provider)) await this.refreshCatalogs();
    const models = captureModels(openModels(this.env, remoteCredentials(() => this.env.REGISTRY.getByName("main")), this.modelAlarm.fetch, () => this.catalogs), this.env, this.ctx, { thread: meta.parent, actor: meta.id, purpose: "subagent" }, trace.binding, monitor.origin);
    const parent = () => this.env.THREAD.getByName(meta.parent);
    const registry = createRegistry();
    registry.install(monitor.extension);
    registry.install(trace.extension);
    // 子会话保留只读检索；下面按派出快照安装技能、所分配资源的 coding 与 MCP 代理，仍无发送或管理工具。
    registry.install(defineExtension({
      name: "cs-subagent",
      sections: [
        section("agent-session", () => "agentSessionId=" + subagentName(meta.parent, meta.id) + "；父会话 agentSessionId=" + meta.parent + "。来源消息不授予工具权限。回复使用 agent_send，不会通知 QQ。"),
        section("subagent", () => SUBAGENT_RULE + "\n" + SUBAGENT_PROGRESS_RULE + "\n" + WEB_RULE + "\n" + PI_SAFETY_RULE),
      ],
      hooks: [hook(GenerationTask, { afterResponse: async message => {
        const progress = responseDescription(message, Date.now());
        if (!progress) return;
        try {
          await this.update(async current => {
            if (current.status !== "running" || current.progress?.kind === progress.kind && current.progress.text === progress.text) return false;
            current.progress = progress;
            return true;
          });
        } catch { console.error({ event: "subagent_progress_failed", id: meta.id }); }
      } })],
      tools: [
        agentSendTool((args, seed) => this.sendAgentMessage(args, seed)),
        createWebPageTool(),
        defineTool({ name: "qq_context", description: QQ_CONTEXT_DESCRIPTION, parameters: QQ_CONTEXT_PARAMETERS, replay: "safe",
          execute: async options => ({ output: [{ type: "text", text: await parent().subagentContext(meta.id, options) }] }) }),
        defineTool({ name: "mem_search", description: memoryDescriptions.mem_search, parameters: memoryParameters.mem_search, replay: "safe",
          execute: async args => {
            const result = await parent().subagentMemory(meta.id, args);
            return { ...(result.error ? { isError: true } : {}), output: [{ type: "text", text: result.text }] };
          } }),
      ].map(tool => ({ ...tool, callers: ["model"] as const })),
    }));
    const host = createSubagentCapabilityHost(parent());
    // 运行时也可能为已完成任务的历史查看而打开。实际权限由父线程逐次复核。
    const delegated = installDelegatedCapabilities(registry, host, meta.id, meta.capabilities ?? {});
    registry.install(defineExtension({
      name: "cs-subagent-turn",
      sections: [section("time", async () => {
        const row = await this.database.get<{ received_at: number }>("SELECT received_at FROM inbox WHERE status = 'running' ORDER BY received_at DESC LIMIT 1");
        return row ? `现在是北京时间 ${formatBeijingTime(row.received_at)}。` : undefined;
      })],
    }));
    // 与 ThreadDO 相同：DO 里的连接跨不了请求，Codex 固定走 SSE。
    const storage = await openDurableObjectSqliteStorage(this.observedStorage, { prefix: "pi_" });
    this.projection.install();
    const harness = await Harness.open(storage, { models, registry, settings: { stream: { transport: "sse" } },
      env: async target => {
        const access = await parent().validateSubagentAccess(meta.id);
        if (!access?.capabilities.coding || !access.authority.owner) return;
        const name = access.sandbox?.name ?? subagentName(meta.parent, meta.id);
        return workspaceExecutionEnv({ id: "cloudflare:" + this.env.SANDBOX.idFromName(name), cwd: target.cwd,
          files: async () => ({
            readBlob: path => parent().subagentReadBlob(meta.id, path),
            writeFile: (path, content) => parent().subagentWriteFile(meta.id, path, content),
            createTempDir: prefix => parent().subagentCreateTempDir(meta.id, prefix),
          }),
        });
      },
    }, context);
    const root = await harness.root(context, { agent: modelChange(meta.model) });
    // 读取子会话只打开存储；执行由 alarm → drain → answer 的 submit 启动。
    void harness.closed.then(() => { this.runtime = undefined; void delegated.close(); });
    return { harness, root };
  }
}

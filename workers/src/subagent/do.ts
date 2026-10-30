import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import type { Message } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness, section, type Conversation, type EntryId } from "@earendil-works/pi-durable";
import { DurableObjectSqliteDatabase, openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import type { Env } from "../env";
import { modelChange, openModels } from "../models";
import { captureModels } from "../requests/capture";
import { remoteCredentials } from "../model-credentials";
import { createWebPageTool } from "../tools/web-page";
import { QQ_CONTEXT_DESCRIPTION, QQ_CONTEXT_PARAMETERS } from "../context";
import { memoryDescriptions, memoryParameters } from "../memory/contracts";
import { formatBeijingTime } from "../memory/time";
import { PI_SAFETY_RULE, WEB_RULE } from "../prompt";
import { RETENTION_MS, subagentName, type SubagentEntry, type SubagentMeta, type SubagentStart, type SubagentState } from "./model";

const context = BACKGROUND_CONTEXT;
// 有未完成的工作时定期自唤醒：驱逐后由 alarm 重新打开 Harness 续跑，并补送没送到父线程的汇报。
const HEARTBEAT_MS = 60_000;
const SUBAGENT_RULE = "你是主 agent 派出的子 agent，只负责完成交给你的任务。你不能联系用户、发消息、写记忆或安排定时；把最终结果完整写在回答里，它会原样交回主 agent。qq_context 与 mem_search 只读派出你的会话。";

/** queued → running → answered（回答已落库）→ reported（父线程已收下）；cancelled 是取消时还没回答的项。 */
type InboxStatus = "queued" | "running" | "answered" | "reported" | "cancelled";
type InboxRow = { request_id: string; text: string; received_at: number; status: InboxStatus; answer: string | null; outcome: "done" | "failed" | null };
type Runtime = { harness: Harness; root: Conversation };

const state = (meta: SubagentMeta): SubagentState => ({ status: meta.status, version: meta.version });
const textOf = (messages: readonly Message[] | undefined) => (messages ?? []).flatMap(message =>
  typeof message.content === "string" ? [message.content]
    : message.content.flatMap(block => block.type === "text" ? [block.text] : block.type === "toolCall" ? [`[${block.name}]`] : [])).join(" ");

export class SubagentDO extends DurableObject<Env> {
  private readonly database = new DurableObjectSqliteDatabase(this.ctx.storage);
  private initialized?: Promise<void>;
  private runtime?: Promise<Runtime>;
  private draining?: Promise<void>;
  private dirty = false;

  private initialize(): Promise<void> {
    return this.initialized ??= this.database.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox (
        request_id TEXT PRIMARY KEY, text TEXT NOT NULL, received_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'answered', 'reported', 'cancelled')),
        answer TEXT, outcome TEXT CHECK (outcome IN ('done', 'failed'))
      );
    `);
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
      if (await change(meta, tx)) {
        meta.version++;
        await tx.run("UPDATE meta SET value = ? WHERE key = 'subagent'", JSON.stringify(meta));
      }
      const pending = meta.status === "running" || meta.status !== "cancelled" && !!await tx.get("SELECT 1 FROM inbox WHERE status = 'answered' LIMIT 1");
      await this.ctx.storage.setAlarm(pending ? Date.now() + HEARTBEAT_MS : (meta.endedAt ?? meta.createdAt) + RETENTION_MS);
      return meta;
    });
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
      const created: SubagentMeta = { ...init, createdAt: now, status: "running", reportCount: 0, version: 1 };
      await tx.run("INSERT INTO meta (key, value) VALUES ('subagent', ?)", JSON.stringify(created));
      await tx.run("INSERT INTO inbox (request_id, text, received_at, status) VALUES ('task', ?, ?, 'queued')", init.task, now);
      await this.ctx.storage.setAlarm(now + HEARTBEAT_MS);
      return created;
    });
    this.kick();
    return state(meta);
  }

  /** 同一 requestId 只收一次；已取消的不再接受，已结束的重新进入运行并保留之前的上下文。 */
  async message(requestId: string, text: string): Promise<{ result: "accepted" | "duplicate" | "ended"; state: SubagentState }> {
    await this.initialize();
    let result = "duplicate" as "accepted" | "duplicate" | "ended";
    const meta = await this.update(async (meta, tx) => {
      if (meta.status === "cancelled") { result = "ended"; return false; }
      if (await tx.get("SELECT 1 FROM inbox WHERE request_id = ?", requestId)) return false;
      await tx.run("INSERT INTO inbox (request_id, text, received_at, status) VALUES (?, ?, ?, 'queued')", requestId, text, Date.now());
      result = "accepted";
      meta.status = "running";
      delete meta.endedAt;
      return true;
    });
    if (result === "accepted") this.kick();
    return { result, state: state(meta) };
  }

  /** 只取消运行中的；已回答未送达的汇报也不再补送。 */
  async cancel(): Promise<SubagentState> {
    await this.initialize();
    let changed = false;
    const meta = await this.update(async (meta, tx) => {
      if (meta.status !== "running") return false;
      await tx.run("UPDATE inbox SET status = 'cancelled' WHERE status IN ('queued', 'running')");
      meta.status = "cancelled";
      meta.endedAt = Date.now();
      return changed = true;
    });
    if (changed) {
      // 冷启动后也要打开 Harness 中止，否则之后任何一次打开都会续跑被取消的运行。
      const aborted = this.open().then(({ root }) => root.abort(context));
      this.ctx.waitUntil(aborted.catch(() => {}));
      await Promise.race([aborted.catch(() => {}), scheduler.wait(2000)]);
    }
    return state(meta);
  }

  async status(): Promise<{ meta: SubagentMeta; inbox: Partial<Record<InboxStatus, number>> } | undefined> {
    const meta = await this.meta();
    if (!meta) return;
    const rows = await this.database.all<{ status: InboxStatus; n: number }>("SELECT status, COUNT(*) AS n FROM inbox GROUP BY status");
    return { meta, inbox: Object.fromEntries(rows.map(row => [row.status, row.n])) };
  }

  /** 面板查看：最近 limit 条会话条目的元数据与文本前 200 字，新的在前。 */
  async transcriptSummary(limit: number): Promise<{ meta: SubagentMeta; entries: SubagentEntry[] } | undefined> {
    const meta = await this.meta();
    if (!meta) return;
    const { harness, root } = await this.open();
    const page = await harness.commit(tx => tx.scanEntries({ conversationId: root.id }, Math.min(50, Math.max(1, Math.trunc(limit)))), context);
    return { meta, entries: page.items.map(entry => ({ id: Number(entry.id), kind: entry.kind,
      ...(entry.model?.[0] ? { role: entry.model[0].role } : {}), text: textOf(entry.model).slice(0, 200) })) };
  }

  override async alarm(): Promise<void> {
    const meta = await this.meta();
    if (meta && Date.now() < (meta.endedAt ?? Infinity) + RETENTION_MS) {
      await this.update(async () => false);
      this.kick();
      return;
    }
    // 结束满 14 天（或从未启动）：整个对象连同 Pi 存储一起删除。
    const runtime = await this.runtime?.catch(() => undefined);
    await runtime?.harness.close(context).catch(() => {});
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.initialized = this.runtime = undefined;
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
        console.error({ event: "subagent_step_failed", error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
        return;
      }
    }
  }

  /** 一次只跑一项输入，每项各得一个回答、各汇报一次；没有可做的返回 false。 */
  private async step(): Promise<boolean> {
    const meta = await this.meta();
    if (!meta || meta.status === "cancelled") return false;
    const answered = await this.database.get<InboxRow>("SELECT * FROM inbox WHERE status = 'answered' ORDER BY received_at, rowid LIMIT 1");
    if (answered) {
      await this.report(meta, answered);
      return true;
    }
    if (meta.status !== "running") return false;
    const next = await this.database.get<InboxRow>(`SELECT * FROM inbox WHERE status IN ('running', 'queued')
      ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, received_at, rowid LIMIT 1`);
    if (!next) return false;
    await this.answer(next);
    return true;
  }

  private async answer(row: InboxRow): Promise<void> {
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
      meta.endedAt = Date.now();
      return true;
    });
  }

  private async answerText(harness: Harness, answer: EntryId): Promise<string> {
    const entry = await harness.commit(tx => tx.entry(answer), context);
    return (entry?.model ?? []).flatMap(message => message.role === "assistant"
      ? message.content.flatMap(block => block.type === "text" ? [block.text] : []) : []).join("").trim();
  }

  private async report(meta: SubagentMeta, row: InboxRow): Promise<void> {
    await this.env.THREAD.getByName(meta.parent).subagentReport({ subagentId: meta.id, requestId: row.request_id, text: row.answer ?? "",
      identity: meta.identity, outcome: row.outcome ?? "failed", state: state(meta) });
    await this.update(async (meta, tx) => {
      await tx.run("UPDATE inbox SET status = 'reported' WHERE request_id = ? AND status = 'answered'", row.request_id);
      meta.reportCount++;
      return true;
    });
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
    const models = captureModels(openModels(this.env, remoteCredentials(() => this.env.REGISTRY.getByName("main"))), this.env, this.ctx, { thread: meta.parent, actor: meta.id, purpose: "subagent" });
    const parent = () => this.env.THREAD.getByName(meta.parent);
    const registry = createRegistry();
    // 子会话只有网页读取与上下文检索工具，不能发消息、写记忆或调用 MCP。
    registry.install(defineExtension({
      name: "cs-subagent",
      sections: [
        section("subagent", () => SUBAGENT_RULE + "\n" + WEB_RULE + "\n" + PI_SAFETY_RULE, { tag: false }),
        section("time", async () => {
          const row = await this.database.get<{ received_at: number }>("SELECT received_at FROM inbox WHERE status = 'running' ORDER BY received_at DESC LIMIT 1");
          return row ? `现在是北京时间 ${formatBeijingTime(row.received_at)}。` : undefined;
        }, { tag: false }),
      ],
      tools: [
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
    // 与 ThreadDO 相同：DO 里的连接跨不了请求，Codex 固定走 SSE。
    const storage = await openDurableObjectSqliteStorage(this.ctx.storage, { prefix: "pi_" });
    const harness = await Harness.open(storage, { models, registry, settings: { stream: { transport: "sse" } } }, context);
    const root = await harness.root(context, { agent: modelChange(meta.model) });
    harness.resume();
    void harness.closed.then(() => { this.runtime = undefined; });
    return { harness, root };
  }
}

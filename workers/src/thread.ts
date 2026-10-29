import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness, InboxDoc, LiveDoc, section, type Conversation, type Submission } from "@earendil-works/pi-durable";
import { DurableObjectSqliteDatabase, openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import type { Env } from "./env";
import { inboundKey, policyFromEnv, scopeOf, type InboundInput, type Target } from "./policy";
import { MESSAGE_SCHEMA, recordMessage, recall } from "./context";
import { PI_SAFETY_RULE, SEND_RULE, turnIdentity } from "./prompt";
import { openModels } from "./models";
import { MEMORY_SCHEMA } from "./memory/schema";
import { MemoryStore } from "./memory/store";
import { parseImport } from "./memory/import";
import { createMemoryTools, type MemoryBinding } from "./memory/tools";
import { MEMORY_RULE } from "./memory/contracts";
import { renderMemorySection } from "./memory/render";
import { MemoryExtractor, directComplete, EXTRACT_ALARM_DELAY_MS, type ExtractComplete } from "./memory/extractor";
import { maintenanceConfig, maintenanceStatus, runMaintenanceJob, type MaintenanceJob, type MaintenanceReport } from "./maintenance";

import { MCP_CATALOG_SCHEMA } from "./mcp/catalog";
import { ThreadMcp } from "./mcp";

const context = BACKGROUND_CONTEXT;
type InboundRow = {
  message_id: string; platform_message_id: string; user_id: string; self_id: string; text: string; received_at: number;
  status: "queued" | "done" | "failed"; chat_kind: "private" | "group"; chat_id: string; nickname: string;
  scope_name: string; turn_id: string | null; when_busy: "steer" | "followUp" | null;
};
type Runtime = { harness: Harness; root: Conversation; selection: { provider: string; id: string } };
const targetOf = (row: InboundRow): Target => row.chat_kind === "group" ? { kind: "group", groupId: row.chat_id } : { kind: "private", userId: row.chat_id };

export class ThreadDO extends DurableObject<Env> {
  private readonly database = new DurableObjectSqliteDatabase(this.ctx.storage);
  private initialized?: Promise<void>;
  private extractionModels?: ReturnType<typeof openModels>;
  private runtime?: Promise<Runtime>;
  private admissions: Promise<void> = Promise.resolve();

  private initialize(): Promise<void> {
    return this.initialized ??= this.database.transaction(async tx => {
      await tx.exec(`
        CREATE TABLE IF NOT EXISTS inbound (
          message_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, text TEXT NOT NULL,
          received_at INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('queued', 'done', 'failed'))
        );
        CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY, message_id TEXT NOT NULL, text TEXT NOT NULL, sent_at INTEGER NOT NULL);
        ${MESSAGE_SCHEMA}
        ${MEMORY_SCHEMA}
        ${MCP_CATALOG_SCHEMA}
      `);
      // 已部署的 P0 表与 submission.requestId 必须保留，新增列用默认值兼容旧回合恢复。
      const columns = await tx.all<{ name: string }>("PRAGMA table_info(inbound)");
      for (const [name, definition] of Object.entries({
        chat_kind: "TEXT NOT NULL DEFAULT 'private'", chat_id: "TEXT NOT NULL DEFAULT ''",
        nickname: "TEXT NOT NULL DEFAULT ''", self_id: "TEXT NOT NULL DEFAULT ''",
        scope_name: "TEXT NOT NULL DEFAULT ''", platform_message_id: "TEXT NOT NULL DEFAULT ''", when_busy: "TEXT", turn_id: "TEXT",
      })) if (!columns.some(column => column.name === name)) await tx.exec(`ALTER TABLE inbound ADD COLUMN ${name} ${definition}`);
      const outboxColumns = await tx.all<{ name: string }>("PRAGMA table_info(outbox)");
      if (!outboxColumns.some(column => column.name === "turn_id")) await tx.exec("ALTER TABLE outbox ADD COLUMN turn_id TEXT");
      await tx.exec("CREATE INDEX IF NOT EXISTS inbound_turn ON inbound(turn_id); CREATE INDEX IF NOT EXISTS outbox_turn ON outbox(turn_id)");
      await tx.run("UPDATE inbound SET chat_id = user_id WHERE chat_id = ''");
      await tx.run("UPDATE inbound SET platform_message_id = message_id WHERE platform_message_id = ''");
    });
  }

  async ingest(input: InboundInput): Promise<void> {
    await this.initialize();
    const ns = input.target.kind === "private" && policyFromEnv(this.env).owners.includes(input.userId) ? "owner" : scopeOf(input.target);
    await this.bindNamespace(ns);
    await this.database.transaction(tx => recordMessage(tx, input));
  }

  private open(): Promise<Runtime> {
    return this.runtime ??= this.openRuntime().catch(error => {
      this.runtime = undefined;
      throw error;
    });
  }

  private async currentInput(harness: Harness, read: Pick<Harness, "snapshot">, conversationId: Conversation["id"], callContext: Context): Promise<InboundRow | undefined> {
    const live = await read.snapshot(LiveDoc, conversationId, callContext);
    // Pi 的 run.taskId 会随工具续轮变化；首条输入 id 在续轮和插话期间稳定，作为宿主回合键。
    if (live?.run) {
      const keys: string[] = [];
      for (const id of live.run.inputs) {
        const record = await (await harness.submission(id, callContext))?.status(callContext);
        if (record?.requestId) keys.push(record.requestId);
      }
      const turnId = `turn:${live.run.inputs[0]}`;
      await this.database.transaction(async tx => {
        for (const key of keys) await tx.run("UPDATE inbound SET turn_id = ? WHERE message_id = ?", turnId, key);
      });
    }
    const inputId = live?.run?.inputs.at(-1);
    const handle = inputId ? await harness.submission(inputId, callContext) : undefined;
    const submission = await handle?.status(callContext);
    return submission?.requestId ? this.database.get<InboundRow>("SELECT * FROM inbound WHERE message_id = ?", submission.requestId) : undefined;
  }

  private async openRuntime(): Promise<Runtime> {
    await this.initialize();
    const { models, selection } = await (this.extractionModels ??= openModels(this.env).catch(error => { this.extractionModels = undefined; throw error; }));
    const memory = new MemoryStore(this.database, await this.namespace());
    // 相同 storage 对象共享事务队列，避免宿主写入被 Pi 的事务一起回滚。
    const storage = await openDurableObjectSqliteStorage(this.ctx.storage, { prefix: "pi_" });
    const registry = createRegistry();
    registry.install(defineExtension({
      name: "cs-workers",
      sections: [
        section("qq", () => SEND_RULE + "\n" + PI_SAFETY_RULE + "\n" + MEMORY_RULE, { tag: false }),
        section("memory", () => renderMemorySection(memory), { tag: false }),
        section("turn-identity", async (api, callContext) => {
          const input = await this.currentInput(harness, api.read, api.conversationId, callContext);
          return input ? turnIdentity({ userId: input.user_id, nickname: input.nickname, target: targetOf(input), scopeName: input.scope_name }, policyFromEnv(this.env).owners.includes(input.user_id)) : undefined;
        }, { tag: false }),
      ],
      tools: [...createMemoryTools(memory, async (api, callContext) => {
        const input = await this.currentInput(harness, api, api.conversationId, callContext);
        return input ? this.memoryBinding(input, memory.ns) : undefined;
      }), defineTool({
        name: "send_message", description: "向本回合所在 QQ 会话发送纯文本；群回复自动 @ 本轮发送者。",
        parameters: Type.Object({ text: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
        // 发 QQ 是外部副作用，中断后禁止自动重放，避免重复发送。
        replay: "unsafe",
        execute: async ({ text }, api, toolContext) => {
          const input = await this.currentInput(harness, api, api.conversationId, toolContext);
          if (!input) throw new Error("current input missing");
          const target = targetOf(input);
          let result;
          try {
            const receipt = await this.env.BRIDGE.getByName("napcat").send(target, text, target.kind === "group" ? input.user_id : undefined);
            await this.database.transaction(async tx => {
              await tx.run("INSERT INTO outbox (message_id, text, sent_at, turn_id) VALUES (?, ?, ?, ?)", receipt.message_id, text, Date.now(), input.turn_id);
              await recordMessage(tx, { messageId: receipt.message_id, selfId: input.self_id, userId: input.self_id,
                nickname: "机器人", target, text, routeText: text, time: Math.floor(Date.now() / 1000),
                mentionedSelf: false, replyToId: input.platform_message_id, imageCount: 0, scopeName: input.scope_name }, true);
            });
            result = { status: "sent", message_id: receipt.message_id };
          } catch (error) {
            // RPC 可能归一化 Error.name，因此用固定前缀识别可向模型说明的拒绝。
            if (!(error instanceof Error)) throw error;
            if (error.message === "channel_down") result = { status: "failed", reason: "channel_down" };
            else if (error.message.startsWith("send_rule: ")) result = { status: "rejected", reason: error.message.slice(11) };
            else throw error;
          }
          return { output: [{ type: "text", text: JSON.stringify(result) }] };
        },
      }), defineTool({
        name: "qq_context", description: "只读检索本回合所在会话的聊天记录；无 query 取最近消息，before 为 Unix 秒。",
        parameters: Type.Object({ query: Type.Optional(Type.String({ maxLength: 1000 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })), before: Type.Optional(Type.Number()) }, { additionalProperties: false }),
        replay: "safe",
        execute: async (options, api, toolContext) => {
          const input = await this.currentInput(harness, api, api.conversationId, toolContext);
          if (!input) throw new Error("current input missing");
          // scope 只来自当前输入，模型没有选择其他会话的参数，owner 也不能跨账号召回。
          return { output: [{ type: "text", text: await recall(this.database, scopeOf(targetOf(input)), options) }] };
        },
      })].map(tool => ({ ...tool, callers: ["model"] as const })),
    }));
    const mcp = memory.ns === "owner" ? new ThreadMcp(this.database, this.env, registry, async (api, callContext) => {
      const input = await this.currentInput(harness, api, api.conversationId, callContext);
      return !!input && this.memoryBinding(input, memory.ns)?.owner === true && input.chat_kind === "private";
    }) : undefined;
    await mcp?.restore();
    const harness = await Harness.open(storage, { models, registry }, context);
    const root = await harness.root(context, { agent: { model: { provider: selection.provider, modelId: selection.id } } });
    await root.configure({ model: { provider: selection.provider, modelId: selection.id } }, context);
    const runtime = { harness, root, selection };
    // requestId 幂等地补齐入库后、Pi 接收前中断的窗口，按原到达顺序恢复。
    for (const row of await this.database.all<InboundRow>("SELECT * FROM inbound WHERE status = 'queued' ORDER BY rowid")) {
      const submission = await this.admit(runtime, row);
      this.ctx.waitUntil(this.settle(row.message_id, submission));
    }
    // 快照先装配，远端离线不阻塞 Harness 恢复；首次执行仍强制核对完整目录。
    if (mcp) this.ctx.waitUntil(mcp.refreshAll().then(() => {}));
    harness.resume();
    void harness.closed.then(async () => { this.runtime = undefined; await mcp?.close(); });
    return runtime;
  }

  private async admit({ harness, root }: Runtime, row: InboundRow): Promise<Submission> {
    let whenBusy = row.when_busy;
    if (!whenBusy) {
      // 先查排队，再读当前回合；已有他人排队时，后来的同人消息也不能越过队首。
      const inbox = await harness.snapshot(InboxDoc, root.id, context);
      const active = await this.currentInput(harness, harness, root.id, context);
      whenBusy = active?.user_id === row.user_id && !inbox?.items.some(item => item.mode === "followUp") ? "steer" : "followUp";
      await this.database.run("UPDATE inbound SET when_busy = ? WHERE message_id = ?", whenBusy, row.message_id);
    }
    return root.submit({ type: "input", content: row.text, requestId: row.message_id, whenBusy }, context);
  }

  private async settle(messageId: string, submission: Submission): Promise<{ status: "done" | "failed" }> {
    let status: "done" | "failed" = "failed";
    let fallbackTurn: string | undefined;
    try {
      const result = await submission.wait(context);
      status = result.status === "done" ? "done" : "failed";
      fallbackTurn = result.answer === undefined ? undefined : `answer:${result.answer}`;
    } finally {
      const store = new MemoryStore(this.database, await this.namespace());
      await this.database.transaction(async tx => {
        const row = await tx.get<InboundRow>("UPDATE inbound SET status = ?, turn_id = COALESCE(turn_id, ?) WHERE message_id = ? RETURNING *", status, fallbackTurn ?? null, messageId);
        if (status !== "done" || !row?.turn_id) return;
        const unfinished = await tx.get("SELECT 1 FROM inbound WHERE turn_id = ? AND status != 'done' LIMIT 1", row.turn_id);
        if (unfinished) return;
        await this.extractor(store).enqueue(row.turn_id, tx);
        if (await tx.get("SELECT 1 FROM extract_queue LIMIT 1") && await this.ctx.storage.getAlarm() === null) {
          await this.ctx.storage.setAlarm(Date.now() + EXTRACT_ALARM_DELAY_MS);
        }
      });
    }
    return { status };
  }

  async submit(input: InboundInput): Promise<{ deduped: true } | { status: "done" | "failed" }> {
    // 只串行接纳，不串行等待回合，否则同一发送者的插话也会被堵到回合结束。
    const admission = this.admissions.then(async () => {
      await this.ingest(input);
      const key = inboundKey(input);
      const legacy = await this.database.get<InboundRow>("SELECT * FROM inbound WHERE message_id = ? AND self_id = '' AND user_id = ?", input.messageId, input.userId);
      if (legacy) return;
      const inserted = await this.database.get<InboundRow>(`INSERT OR IGNORE INTO inbound
        (message_id, platform_message_id, user_id, self_id, text, received_at, status, chat_kind, chat_id, nickname, scope_name)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?) RETURNING *`, key, input.messageId, input.userId, input.selfId, input.text, input.time,
        input.target.kind, input.target.kind === "group" ? input.target.groupId : input.target.userId, input.nickname, input.scopeName ?? "");
      if (!inserted) return;
      try {
        const runtime = await this.open();
        const row = await this.database.get<InboundRow>("SELECT * FROM inbound WHERE message_id = ?", key);
        return { key, submission: await this.admit(runtime, row ?? inserted) };
      } catch {
        await this.database.run("UPDATE inbound SET status = 'failed' WHERE message_id = ?", key);
        return { failed: true };
      }
    });
    this.admissions = admission.then(() => {}, () => {});
    const admitted = await admission;
    if (!admitted) return { deduped: true };
    if ("failed" in admitted) return { status: "failed" };
    return this.settle(admitted.key, admitted.submission);
  }

  async stats() {
    await this.initialize();
    const rows = await this.database.all<{ status: "queued" | "done" | "failed"; n: number }>("SELECT status, COUNT(*) AS n FROM inbound GROUP BY status");
    const inbound = { queued: 0, done: 0, failed: 0 };
    for (const row of rows) inbound[row.status] = row.n;
    const out = await this.database.get<{ n: number; last: number | null }>("SELECT COUNT(*) AS n, MAX(sent_at) AS last FROM outbox");
    const active = await this.database.get<{ n: number }>("SELECT COUNT(*) AS n FROM memories WHERE status = 'active'");
    const profile = await this.database.get<{ n: number }>("SELECT COALESCE(SUM(length(CAST(text AS BLOB))), 0) AS n FROM profile");
    const queue = await this.database.get<{ n: number }>("SELECT COUNT(*) AS n FROM extract_queue");
    return { inbound, outbox: out?.n ?? 0, ...(out?.last ? { lastSentAt: out.last } : {}),
      memory: { active: active?.n ?? 0, profileBytes: profile?.n ?? 0, extractQueue: queue?.n ?? 0 },
      maintenance: await maintenanceStatus(this.database, this.ctx.storage) };
  }

  private async bindNamespace(ns: string): Promise<void> {
    // RPC 的 ns 不能把不同会话的数据塞进同一个 DO；名称经绑定的 idFromName 复核。
    if (!this.ctx.id.equals(this.env.THREAD.idFromName(ns))) throw new Error("thread namespace mismatch");
    await this.database.run("INSERT OR IGNORE INTO thread_namespace(ns) VALUES (?)", ns);
  }

  private async namespace(): Promise<string> {
    const row = await this.database.get<{ ns: string }>("SELECT ns FROM thread_namespace LIMIT 1");
    if (row) return row.ns;
    if (this.ctx.id.equals(this.env.THREAD.idFromName("owner"))) return "owner";
    // P0/P1a 冷启动可从已有输入恢复；不能从客户端的显示名猜测命名空间。
    const input = await this.database.get<InboundRow>("SELECT * FROM inbound ORDER BY rowid LIMIT 1");
    if (!input) return "";
    const ns = scopeOf(targetOf(input));
    await this.bindNamespace(ns);
    return ns;
  }

  private memoryBinding(input: InboundRow, ns: string): MemoryBinding | undefined {
    if (!input.turn_id) return;
    const owner = policyFromEnv(this.env).owners.includes(input.user_id);
    const expected = owner && input.chat_kind === "private" ? "owner" : scopeOf(targetOf(input));
    if (expected !== ns || input.user_id === input.self_id) return;
    return { ns, owner, userId: input.user_id, turnId: input.turn_id, scope: scopeOf(targetOf(input)), messageId: input.platform_message_id };
  }

  // 抽取、摘要与整理都是无工具的单次补全，共用抽取模型配置。
  private readonly complete: ExtractComplete = async (prompt, signal) => {
    const { models, selection } = await (this.extractionModels ??= openModels(this.env).catch(error => { this.extractionModels = undefined; throw error; }));
    signal.throwIfAborted();
    return directComplete(models, selection.provider, this.env.MEMORY_EXTRACT_MODEL?.trim() || selection.id)(prompt, signal);
  };

  private extractor(store: MemoryStore): MemoryExtractor {
    return new MemoryExtractor(store, this.complete, () => !!store.ns && (this.env.MEMORY_EXTRACT_NAMESPACES ?? "owner").split(",").map(ns => ns.trim()).includes(store.ns));
  }

  override async alarm(): Promise<void> {
    await this.initialize();
    const store = new MemoryStore(this.database, await this.namespace());
    // 先续约闹钟：处理中若进程中断，未领取的回合仍会被唤醒。
    await this.database.transaction(async () => { await this.ctx.storage.setAlarm(Date.now() + 65_000); });
    try { await this.extractor(store).drain(); }
    finally {
      await this.database.transaction(async tx => {
        if (await tx.get("SELECT 1 FROM extract_queue LIMIT 1")) await this.ctx.storage.setAlarm(Date.now() + EXTRACT_ALARM_DELAY_MS);
        else await this.ctx.storage.deleteAlarm();
      });
    }
  }

  async maintain(job: MaintenanceJob): Promise<MaintenanceReport> {
    await this.initialize();
    return runMaintenanceJob(job.kind, { db: this.database, kv: this.ctx.storage, store: new MemoryStore(this.database, await this.namespace()),
      complete: this.complete, config: maintenanceConfig(this.env), now: job.now });
  }

  async importMemory(value: unknown): Promise<{ inserted: number; skipped: number }> {
    const data = parseImport(value);
    await this.initialize();
    await this.bindNamespace(data.ns);
    return new MemoryStore(this.database, data.ns).import(data);
  }

  async mcpToolCounts(): Promise<Record<string, number>> {
    await this.initialize();
    const rows = await this.database.all<{ server_id: string; n: number }>("SELECT server_id, COUNT(*) AS n FROM mcp_catalog GROUP BY server_id");
    return Object.fromEntries(rows.map(row => [row.server_id, row.n]));
  }

  async modelStatus(): Promise<{ provider: string; id: string } | { unavailable: string }> {
    try { return (await this.open()).selection; }
    catch (error) {
      return { unavailable: error instanceof Error ? error.message.slice(0, 160) : "unknown" };
    }
  }
}

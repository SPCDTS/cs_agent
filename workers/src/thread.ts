import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness, LiveDoc, section, type Submission } from "@earendil-works/pi-durable";
import { DurableObjectSqliteDatabase, openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import type { Env } from "./env";
import type { InboundInput } from "./onebot";
import { openModels } from "./models";

const context = BACKGROUND_CONTEXT;
type InboundRow = { message_id: string; user_id: string; text: string; received_at: number; status: "queued" | "done" | "failed" };
type Runtime = { harness: Harness; root: Awaited<ReturnType<Harness["root"]>>; selection: { provider: string; id: string } };

export class ThreadDO extends DurableObject<Env> {
  private readonly database = new DurableObjectSqliteDatabase(this.ctx.storage);
  private initialized?: Promise<void>;
  private runtime?: Promise<Runtime>;

  private initialize(): Promise<void> {
    return this.initialized ??= this.database.exec(`
      CREATE TABLE IF NOT EXISTS inbound (
        message_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, text TEXT NOT NULL,
        received_at INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('queued', 'done', 'failed'))
      );
      CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY, message_id TEXT NOT NULL, text TEXT NOT NULL, sent_at INTEGER NOT NULL);
    `);
  }

  private open(): Promise<Runtime> {
    return this.runtime ??= this.openRuntime().catch(error => {
      this.runtime = undefined;
      throw error;
    });
  }

  private async openRuntime(): Promise<Runtime> {
    await this.initialize();
    const { models, selection } = await openModels(this.env);
    // 两个适配器拿到同一个 storage 对象，包内部 WeakMap 会让宿主表与 Pi 共享事务队列。
    const storage = await openDurableObjectSqliteStorage(this.ctx.storage, { prefix: "pi_" });
    const registry = createRegistry();
    registry.install(defineExtension({
      name: "cs-workers",
      sections: [section("qq", () => "你是主人的 QQ 助手，回复用 send_message 发出，不要发多条，不发 Markdown", { tag: false })],
      tools: [defineTool({
        name: "send_message", description: "向本回合的 QQ 主人发送一条纯文本消息。",
        parameters: Type.Object({ text: Type.String({ minLength: 1 }) }),
        // 发 QQ 是外部副作用，执行中断后禁止自动重放，避免重复发送。
        replay: "unsafe",
        execute: async ({ text }, api, toolContext) => {
          // DO 的 RPC 会在 await 时交错；当前 run 的 submission 才是收件人的可靠来源。
          const live = await api.snapshot(LiveDoc, api.conversationId, toolContext);
          const inputId = live?.run?.inputs.at(-1);
          const handle = inputId ? await harness.submission(inputId, toolContext) : undefined;
          const submission = await handle?.status(toolContext);
          const input = submission?.requestId
            ? await this.database.get<InboundRow>("SELECT * FROM inbound WHERE message_id = ?", submission.requestId) : undefined;
          if (!input) throw new Error("current input missing");
          let result;
          try {
            const receipt = await this.env.BRIDGE.getByName("napcat").sendPrivate(input.user_id, text);
            await this.database.run("INSERT INTO outbox (message_id, text, sent_at) VALUES (?, ?, ?)", receipt.message_id, text, Date.now());
            result = { status: "sent", message_id: receipt.message_id };
          } catch (error) {
            // RPC 传输可能把自定义 Error.name 归一化，固定 message 也作为兼容判据。
            if (!(error instanceof Error) || (error.name !== "channel_down" && error.message !== "channel_down")) throw error;
            result = { status: "failed", reason: "channel_down" };
          }
          return { output: [{ type: "text", text: JSON.stringify(result) }] };
        },
      })],
    }));
    const harness = await Harness.open(storage, { models, registry }, context);
    const root = await harness.root(context, { agent: { model: { provider: selection.provider, modelId: selection.id } } });
    await root.configure({ model: { provider: selection.provider, modelId: selection.id } }, context);
    // requestId 关联宿主入站键，补齐入库后、Pi 接收前中断的窗口，也不会重复已接收的输入。
    for (const row of await this.database.all<InboundRow>("SELECT * FROM inbound WHERE status = 'queued' ORDER BY rowid")) {
      const submission = await root.submit({ type: "input", content: row.text, requestId: row.message_id }, context);
      this.ctx.waitUntil(this.settle(row.message_id, submission));
    }
    harness.resume();
    void harness.closed.then(() => { this.runtime = undefined; });
    return { harness, root, selection };
  }

  private async settle(messageId: string, submission: Submission): Promise<{ status: "done" | "failed" }> {
    let status: "done" | "failed" = "failed";
    try { status = (await submission.wait(context)).status === "done" ? "done" : "failed"; }
    finally { await this.database.run("UPDATE inbound SET status = ? WHERE message_id = ?", status, messageId); }
    return { status };
  }

  async submit(input: InboundInput): Promise<{ deduped: true } | { status: "done" | "failed" }> {
    await this.initialize();
    const inserted = await this.database.get<{ message_id: string }>(
      "INSERT OR IGNORE INTO inbound (message_id, user_id, text, received_at, status) VALUES (?, ?, ?, ?, 'queued') RETURNING message_id",
      input.messageId, input.userId, input.text, input.time,
    );
    if (!inserted) return { deduped: true };
    try {
      const { root } = await this.open();
      const submission = await root.submit({ type: "input", content: input.text, requestId: input.messageId }, context);
      return await this.settle(input.messageId, submission);
    } catch {
      await this.database.run("UPDATE inbound SET status = 'failed' WHERE message_id = ?", input.messageId);
      return { status: "failed" };
    }
  }

  async modelStatus(): Promise<{ provider: string; id: string } | { unavailable: string }> {
    try { return (await this.open()).selection; }
    catch (error) {
      // 只给出错误的分类文本（本包抛出的固定消息或 fetch 失败），不含网关正文或凭据
      return { unavailable: error instanceof Error ? error.message.slice(0, 160) : "unknown" };
    }
  }
}

import type { Context } from "@earendil-works/chord/context";
import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import type { Env } from "../env";
import { McpToolSelectionSchema, type McpToolSelection } from "../mcp/access";
import { ResourceIdSchema } from "../sandbox/resources";
import { ownerIds, scopeOf, type InboundInput, type Target } from "../policy";
import { ModelSelectionSchema, type ModelSelection } from "../settings";
import { formatBeijingTime } from "../memory/time";
import { shortSummary } from "./activity";
import {
  MIN_TIMEOUT_MS, SUBAGENT_ID, clip, confirmedIdentity, narrowIdentity, reportKey, reportText, stableId, subagentName,
  type ParentSubagentStatus, type SubagentCapabilities, type SubagentIdentity, type SubagentReport, type SubagentState,
} from "./model";

export const SUBAGENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS subagents (
  id TEXT PRIMARY KEY, task TEXT NOT NULL, summary TEXT, created_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed', 'cancelled', 'timeout')),
  ended_at INTEGER, identity_json TEXT NOT NULL, last_report_at INTEGER,
  origin_json TEXT NOT NULL, timeout_ms INTEGER NOT NULL, deadline INTEGER NOT NULL, child_version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS subagents_deadline ON subagents(status, deadline);
`;

/** 汇报回合回到派出时的会话：目标、机器人号与群名。 */
export type SubagentOrigin = { capabilities?: SubagentCapabilities; model?: ModelSelection; workspaceRevision?: string; generation?: number; target: Target; selfId: string; scopeName: string; replyChannel?: "web" };
export type SubagentCaller = { identity: SubagentIdentity; origin: SubagentOrigin };
export type SubagentView = {
  id: string; task: string; summary: string; status: ParentSubagentStatus; createdAt: number; deadline: number | null;
  endedAt?: number; lastReportAt?: number; spawner?: string; sandboxId?: string; model?: ModelSelection;
};
type Row = {
  id: string; task: string; summary: string | null; created_at: number; status: ParentSubagentStatus; ended_at: number | null; identity_json: string;
  last_report_at: number | null; origin_json: string; timeout_ms: number; deadline: number; child_version: number;
};
type Reply = { text: string; error?: true };
type Host = {
  db: DurableObjectSqliteDatabase; env: Env;
  /** 父线程键，也是子 DO 名字的一段。 */
  thread(): Promise<string>;
  /** 把汇报作为 kind=subagent 的输入入队，入站键幂等。 */
  wake(input: InboundInput): Promise<"accepted" | "duplicate">;
  /** 让父 DO 的 alarm 不晚于 at 触发。 */
  wakeBy(at: number): Promise<void>;
  audit(kind: string, detail: object): Promise<unknown>;
};

const STATUS_TEXT: Record<ParentSubagentStatus, string> = { running: "运行中", done: "已完成", failed: "失败", cancelled: "已取消", timeout: "已超时" };
const ENDED = "('cancelled', 'timeout')";
const span = (ms: number) => ms < 60_000 ? `${Math.round(ms / 1000)} 秒` : `${Math.round(ms / 60_000)} 分钟`;
const reply = (text: string, error = false) => ({ ...(error ? { isError: true } : {}), output: [{ type: "text" as const, text }] });

const PARAMETERS = Type.Object({
  action: Type.Union([Type.Literal("spawn"), Type.Literal("message"), Type.Literal("set_model"), Type.Literal("list"), Type.Literal("cancel")]),
  sandboxId: Type.Optional(ResourceIdSchema),
  mcpTools: Type.Optional(McpToolSelectionSchema),
  model: Type.Optional(Type.Object({
    ...ModelSelectionSchema.properties,
  }, { additionalProperties: false, description: "仅主人交互会话可用：为 spawn / message / set_model 显式指定或切换该子 agent 的模型（省略时沿用子任务默认模型或主模型）" })),
  task: Type.Optional(Type.String({ minLength: 1, maxLength: 20000, description: "spawn 必填：自包含的任务目标、上下文与验收标准" })),
  summary: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: "spawn 必填：15–30 字中文任务简介（供管理台展示，不含凭据或原始参数）" })),
  id: Type.Optional(Type.String({ pattern: `^${SUBAGENT_ID}$`, description: "message / set_model / cancel 必填：spawn 或 list 返回的子 agent ID" })),
  text: Type.Optional(Type.String({ minLength: 1, maxLength: 20000, description: "message 必填：追加给该子 agent 的说明" })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: MIN_TIMEOUT_MS, description: "spawn 可选：明确截止时长（毫秒）；无硬期限请省略" })),
}, { additionalProperties: false });
const DESCRIPTION = "管理后台独立上下文子 agent（spawn 派出 / message 追问 / set_model 切换模型 / list 查看 / cancel 取消）。spawn 立即返回，结果以“[子 agent 完成]”自动唤醒父回合；勿轮询 list。默认继承子任务默认模型或当前主模型，主人会话可通过 model 为单个子任务指定或切换模型。默认继承当前会话已批准的技能与 MCP；传 mcpTools 可按服务与原始工具名收敛权限（空数组为不授 MCP，且不含 MCP 资源读取）。传 sandboxId 绑定 sandbox_list 中的工作区（同 ID 共享文件与运行时；需隔离请先调 sandbox_create 再传入返回 ID；省略则继承父默认工作区）。子 agent 不能直接发消息、改权限、改模型或发布技能。";

/** 父线程的子 agent 登记：派出、交代、取消、汇报入队与超时，都经这张表。 */
export class ParentSubagents {
  constructor(private readonly host: Host) {}

  private child(thread: string, id: string) {
    return this.host.env.SUBAGENT.getByName(subagentName(thread, id));
  }

  private row(id: string): Promise<Row | undefined> {
    return this.host.db.get<Row>("SELECT * FROM subagents WHERE id = ?", id);
  }

  /** 采纳子 DO 更新的版本；父线程已判定取消或超时的不再改。 */
  private async apply(id: string, state: SubagentState): Promise<void> {
    await this.host.db.run(`UPDATE subagents SET status = ?, child_version = ?, ended_at = CASE WHEN ? = 'running' THEN NULL ELSE COALESCE(ended_at, ?) END
      WHERE id = ? AND child_version < ? AND status NOT IN ${ENDED}`, state.status, state.version, state.status, Date.now(), id, state.version);
  }

  private input(row: Row, identity: SubagentIdentity, key: string, text: string): InboundInput {
    const origin = JSON.parse(row.origin_json) as SubagentOrigin;
    const as = confirmedIdentity(identity, ownerIds(this.host.env)).as;
    // 没有确证的派出者时 userId 留空：所有按人求权限的地方都只剩会话基础权限。
    return { messageId: key, selfId: origin.selfId, userId: as?.userId ?? "", nickname: as?.nickname ?? "", target: origin.target,
      text, routeText: text, time: Math.floor(Date.now() / 1000), mentionedSelf: false, replyToId: null, imageCount: 0,
      scopeName: origin.scopeName, replyChannel: origin.replyChannel, kind: "subagent" };
  }

  async spawn(caller: SubagentCaller, task: string, timeoutMs: number | undefined, model: ModelSelection, seed: string, summary?: string): Promise<Reply> {
    const thread = await this.host.thread(), id = await stableId(`${thread}:${seed}`), now = Date.now();
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || !Number.isSafeInteger(now + timeoutMs)))
      return { text: "timeoutMs 必须为至少 1000 的安全整数，且截止时间不能溢出。", error: true };
    // 0 表示不设截止时间，兼容已保存的 NOT NULL 列；显式 timeoutMs 才安排父 alarm。
    const timeout = timeoutMs ?? 0;
    const origin: SubagentOrigin = { ...caller.origin, model };
    await this.host.db.run(`INSERT OR IGNORE INTO subagents (id, task, summary, created_at, status, identity_json, origin_json, timeout_ms, deadline)
      VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`, id, task, shortSummary(summary || task), now, JSON.stringify(caller.identity), JSON.stringify(origin), timeout, timeout ? now + timeout : 0);
    const row = (await this.row(id))!;
    try {
      await this.apply(id, await this.child(thread, id).start({ parent: thread, id, task: row.task, summary: row.summary ?? shortSummary(row.task), identity: JSON.parse(row.identity_json) as SubagentIdentity, model, capabilities: (JSON.parse(row.origin_json) as SubagentOrigin).capabilities }));
    } catch (error) {
      console.error({ event: "subagent_start_failed", id, error: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
      await this.host.db.run("UPDATE subagents SET status = 'failed', ended_at = ? WHERE id = ? AND status = 'running'", Date.now(), id);
      return { text: "子 agent 启动失败，请稍后再试。", error: true };
    }
    if (row.deadline) await this.host.wakeBy(row.deadline);
    await this.host.audit("subagent_spawn", { id, model: `${model.provider}/${model.id}`, timeoutMs: row.timeout_ms, chars: row.task.length });
    return { text: `已派出子 agent ${id}（模型 ${model.provider}/${model.id}，${row.timeout_ms ? "限时 " + span(row.timeout_ms) : "不设自动超时"}），完成后结果会作为「[子 agent 完成]」输入交回给你。` };
  }

  async message(caller: SubagentCaller, id: string, text: string, seed: string, nextModel?: ModelSelection): Promise<Reply> {
    const row = await this.row(id);
    if (!row) return { text: `本会话没有子 agent ${id}`, error: true };
    if (row.status === "cancelled" || row.status === "timeout") return { text: `子 agent ${id} ${STATUS_TEXT[row.status]}，不能再发消息；需要的话重新 spawn。`, error: true };
    const savedOrigin = JSON.parse(row.origin_json) as SubagentOrigin;
    if (savedOrigin.generation !== caller.origin.generation) return {text:"该子任务属于已归档会话，请重新 spawn。",error:true};
    if (savedOrigin.replyChannel !== caller.origin.replyChannel) return { text: "这个子任务属于另一个回复入口，请在当前入口新建子任务。", error: true };
    // 这一轮交代的内容会进入子 agent 的上下文：登记的身份与本轮合并，不是同一人就降为基础权限，之后的汇报都按合并后的身份。
    const identity = narrowIdentity(JSON.parse(row.identity_json) as SubagentIdentity, caller.identity);
    const updatedOrigin = nextModel ? { ...savedOrigin, model: nextModel } : savedOrigin;
    await this.host.db.run("UPDATE subagents SET identity_json = ?, origin_json = ? WHERE id = ?", JSON.stringify(identity), JSON.stringify(updatedOrigin), id);
    const { result, state } = await this.child(await this.host.thread(), id).message(`m-${(await stableId(seed)).slice(0, 23)}`, text, nextModel);
    await this.apply(id, state);
    if (result === "ended") return { text: `子 agent ${id} 已取消，不能再发消息。`, error: true };
    if (nextModel && result === "accepted") {
      await this.host.audit("model_change", { target: "subagent_instance", subagentId: id, model: `${nextModel.provider}/${nextModel.id}`, result: "ok" });
    }
    const deadline = row.timeout_ms ? Date.now() + row.timeout_ms : 0;
    await this.host.db.run("UPDATE subagents SET deadline = ? WHERE id = ? AND status = 'running'", deadline, id);
    if (deadline) await this.host.wakeBy(deadline);
    return { text: `已把消息交给子 agent ${id}${nextModel ? `（模型已切换为 ${nextModel.provider}/${nextModel.id}）` : ""}，回答会作为「[子 agent 完成]」输入交回给你。` };
  }

  async setModel(caller: SubagentCaller, id: string, nextModel: ModelSelection, seed: string): Promise<Reply> {
    const thread = await this.host.thread();
    if (!caller.identity.as?.owner) {
      return { text: "只有 owner 权限的非子任务交互回合可以切换子 agent 的模型。", error: true };
    }
    const check = await this.host.env.REGISTRY.getByName("main").validateModel(nextModel);
    if (!check.ok) {
      await this.host.audit("model_change", { target: "subagent_instance", subagentId: id, model: `${nextModel.provider}/${nextModel.id}`, result: "invalid_model" });
      return { text: `目标模型不可用（${check.reason}），请先用 model_manage 查看已就绪模型。`, error: true };
    }
    const row = await this.row(id);
    if (!row) return { text: `本会话没有子 agent ${id}`, error: true };
    if (row.status === "cancelled" || row.status === "timeout") return { text: `子 agent ${id} ${STATUS_TEXT[row.status]}，不能切换模型。`, error: true };
    const savedOrigin = JSON.parse(row.origin_json) as SubagentOrigin;
    if (savedOrigin.generation !== caller.origin.generation) return { text: "该子任务属于已归档会话，不能切换模型。", error: true };
    if (savedOrigin.replyChannel !== caller.origin.replyChannel) return { text: "这个子任务属于另一个回复入口，不能跨入口切换模型。", error: true };
    const { result, state } = await this.child(thread, id).setModel(`mm-${(await stableId(seed)).slice(0, 22)}`, nextModel);
    await this.apply(id, state);
    if (result === "ended") return { text: `子 agent ${id} 已取消，不能切换模型。`, error: true };
    await this.host.db.run("UPDATE subagents SET origin_json = ? WHERE id = ?", JSON.stringify({ ...savedOrigin, model: nextModel }), id);
    if (result === "updated") {
      await this.host.audit("model_change", { target: "subagent_instance", subagentId: id, model: `${nextModel.provider}/${nextModel.id}`, result: "ok" });
    }
    return { text: `已将子 agent ${id} 的模型切换为 ${nextModel.provider}/${nextModel.id}${nextModel.reasoningEffort ? `（推理 ${nextModel.reasoningEffort}）` : ""}，自下一次模型请求起生效。` };
  }

  /** 只取消运行中的；子 DO 已经答完的保持它的结果，汇报照常送达。 */
  async cancel(id: string): Promise<ParentSubagentStatus | undefined> {
    const row = await this.row(id);
    if (!row || row.status !== "running") return row?.status;
    try { await this.apply(id, await this.child(await this.host.thread(), id).cancel()); }
    catch { console.error({ event: "subagent_cancel_failed", id }); }
    await this.host.db.run("UPDATE subagents SET status = 'cancelled', ended_at = ? WHERE id = ? AND status = 'running'", Date.now(), id);
    return (await this.row(id))?.status;
  }

  async report(report: SubagentReport): Promise<"accepted" | "duplicate" | "ignored"> {
    const row = await this.row(report.subagentId);
    if (!row || row.status === "cancelled" || row.status === "timeout") return "ignored";
    await this.apply(row.id, report.state);
    await this.host.db.run("UPDATE subagents SET last_report_at = ? WHERE id = ?", Date.now(), row.id);
    const identity = narrowIdentity(JSON.parse(row.identity_json) as SubagentIdentity, report.identity);
    const result = await this.host.wake(this.input(row, identity, reportKey(row.id, report.requestId), reportText(report.outcome, row.id, row.task, report.text)));
    if (result === "accepted") await this.host.audit("subagent_report", { id: row.id, outcome: report.outcome, ms: Date.now() - row.created_at, chars: report.text.length });
    return result;
  }

  /** 父 DO alarm 调用：到期的先取消子 DO、再唤醒、最后落状态，中途中断时下次 alarm 重做，每一步都幂等。 */
  async expire(now: number): Promise<void> {
    const thread = await this.host.thread();
    for (const row of await this.host.db.all<Row>("SELECT * FROM subagents WHERE status = 'running' AND deadline > 0 AND deadline <= ?", now)) {
      try {
        const state = await this.child(thread, row.id).cancel();
        // 到期前刚好答完：按完成处理，汇报照常送达。
        if (state.status === "done" || state.status === "failed") { await this.apply(row.id, state); continue; }
      } catch { console.error({ event: "subagent_cancel_failed", id: row.id }); }
      await this.host.wake(this.input(row, JSON.parse(row.identity_json) as SubagentIdentity, reportKey(row.id, `timeout@${row.deadline}`),
        reportText("timeout", row.id, row.task, `超过限时 ${span(row.timeout_ms)} 仍未完成，已取消。`)));
      await this.host.db.run("UPDATE subagents SET status = 'timeout', ended_at = ? WHERE id = ? AND status = 'running'", now, row.id);
      await this.host.audit("subagent_report", { id: row.id, outcome: "timeout", ms: now - row.created_at, chars: 0 });
    }
  }

  async nextDeadline(db: SqliteExecutor = this.host.db): Promise<number | undefined> {
    return (await db.get<{ at: number | null }>("SELECT MIN(deadline) AS at FROM subagents WHERE status = 'running' AND deadline > 0"))?.at ?? undefined;
  }

  async running(): Promise<number> {
    return (await this.host.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM subagents WHERE status = 'running'"))?.n ?? 0;
  }

  async list(): Promise<SubagentView[]> {
    const rows = await this.host.db.all<Row>("SELECT * FROM subagents ORDER BY created_at DESC LIMIT 50");
    return rows.map(row => {
      const as = (JSON.parse(row.identity_json) as SubagentIdentity).as;
      const origin = JSON.parse(row.origin_json) as SubagentOrigin;
      const sandboxId = origin.capabilities?.sandboxId;
      return { ...(sandboxId ? { sandboxId } : {}), ...(origin.model ? { model: origin.model } : {}), id: row.id, task: clip(row.task, 200), summary: row.summary ?? shortSummary(row.task), status: row.status, createdAt: row.created_at, deadline: row.deadline || null,
        ...(row.ended_at === null ? {} : { endedAt: row.ended_at }), ...(row.last_report_at === null ? {} : { lastReportAt: row.last_report_at }),
        ...(as ? { spawner: `${as.owner ? "owner" : "成员"} ${as.userId}` } : {}) };
    });
  }

  /** 子 DO 只读 RPC 的取数范围：派出时的会话与当前确证的身份；不在本线程登记的子 agent 一律没有。 */
  async access(id: string, completed = false): Promise<{ scope: string; identity: SubagentIdentity; origin: SubagentOrigin } | undefined> {
    const row = await this.row(id);
    if (!row || row.status !== "running" && !(completed && (row.status === "done" || row.status === "failed"))) return;
    const origin = JSON.parse(row.origin_json) as SubagentOrigin;
    return { scope: scopeOf(origin.target), origin,
      identity: confirmedIdentity(JSON.parse(row.identity_json) as SubagentIdentity, ownerIds(this.host.env)) };
  }

  async exists(id: string): Promise<boolean> {
    return !!await this.row(id);
  }

  /** 只在用户亲自发消息的回合可用；caller 由 ThreadDO 按当前输入求出，每次执行都重新求。 */
  tool(caller: (api: ToolExecutionApi, context: Context, selection: { sandboxId?: string; mcpTools?: McpToolSelection }) => Promise<SubagentCaller | undefined>, model: () => Promise<ModelSelection>) {
    return defineTool({
      name: "subagent", description: DESCRIPTION, parameters: PARAMETERS,
      // spawn 的 id 与 message / set_model 的 requestId 都由本次工具调用的任务 id 求出，中断后重放找回同一个子 agent 与同一条操作。
      replay: "safe",
      execute: async (args, api, context) => {
        if ((args.sandboxId || args.mcpTools) && args.action !== "spawn") return reply("sandboxId 与 mcpTools 只用于 spawn；已有子任务不能改绑。", true);
        if (args.model && !["spawn", "message", "set_model"].includes(args.action)) return reply("model 只用于 spawn、message 或 set_model。", true);
        const who = await caller(api, context, { sandboxId: args.sandboxId, mcpTools: args.mcpTools });
        if (!who) return reply("子 agent 只能在用户亲自发消息的回合使用；本轮请勿重试。", true);
        const seed = `${api.conversationId}:${api.taskId}`;
        if (args.action === "set_model") {
          if (!args.id || !args.model) return reply("set_model 需要 id 与 model", true);
          const result = await this.setModel(who, args.id, args.model, seed);
          return reply(result.text, result.error);
        }
        if (args.model) {
          if (!who.identity.as?.owner) {
            return reply("只有 owner 权限的非子任务交互回合可以指定或切换子 agent 的模型。", true);
          }
          const check = await this.host.env.REGISTRY.getByName("main").validateModel(args.model);
          if (!check.ok) {
            return reply(`目标模型不可用（${check.reason}），请先用 model_manage 查看已就绪模型。`, true);
          }
        }
        if (args.action === "spawn") {
          if (!args.task || args.id || args.text) return reply("spawn 需要 task 与任务短简介 summary（可选 timeoutMs、model）", true);
          const result = await this.spawn(who, args.task, args.timeoutMs, args.model ?? await model(), seed, args.summary);
          return reply(result.text, result.error);
        }
        if (args.action === "message") {
          if (!args.id || !args.text) return reply("message 需要 id 与 text", true);
          const result = await this.message(who, args.id, args.text, seed, args.model);
          return reply(result.text, result.error);
        }
        if (args.action === "cancel") {
          if (!args.id) return reply("cancel 需要 id", true);
          const status = await this.cancel(args.id);
          return status ? reply(`子 agent ${args.id}：${STATUS_TEXT[status]}`) : reply(`本会话没有子 agent ${args.id}`, true);
        }
        const views = await this.list();
        return reply(views.map(view => `${view.id} · ${STATUS_TEXT[view.status]}${view.model ? ` · 模型 ${view.model.provider}/${view.model.id}` : ""}${view.sandboxId ? " · 沙箱 " + view.sandboxId : ""} · 派出 ${formatBeijingTime(view.createdAt)}（北京时间） · 任务：${clip(view.task.replace(/\s+/g, " "), 80)}`)
          .join("\n") || "本会话没有子 agent。");
      },
    });
  }
}

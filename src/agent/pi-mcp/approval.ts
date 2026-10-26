import { randomInt } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, defineDocFamily, type Harness, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { z } from "zod";
import type { InboundRecord } from "../../channel/types.js";
import { isOwner, type OwnerIds } from "../../shared/owners.js";
import { redactText } from "../../shared/redact.js";
import { trace } from "../../shared/trace.js";
import type { SendService } from "../send-service.js";
import { digest, jsonBytes } from "./catalog.js";
import type { McpConfigState } from "./config.js";

const approvalCall = z.strictObject({
  code: z.string(), server_id: z.string(), server_digest: z.string(), tool: z.string(),
  args: z.record(z.string(), z.json()), args_digest: z.string(),
  requester: z.string(), requester_name: z.string(), scope: z.templateLiteral(["group:", z.string()]), thread_key: z.string(),
  conversation_id: z.number().int().positive(), call_id: z.string(), requested_at: z.number(), expires_at: z.number(), request_message_id: z.string().optional(),
});
const decision = { decided_at: z.number(), decided_by: z.string(), decision_input_key: z.string() };
const approvalSchema = z.discriminatedUnion("state", [
  approvalCall.extend({ state: z.literal("pending") }),
  approvalCall.extend({ state: z.enum(["rejected", "expired"]), decided_at: z.number() }),
  approvalCall.extend({ state: z.literal("executing"), ...decision }),
  approvalCall.extend({ state: z.enum(["done", "failed", "unknown"]), ...decision, result_summary: z.string() }),
]);
type ApprovalCall = z.infer<typeof approvalCall>;
export type McpApproval = z.infer<typeof approvalSchema>;
export const McpApprovalDoc = defineDocFamily<{ record: McpApproval | null }, string>({
  kind: "cs.mcp.approval", version: 1, scope: "session", family: true, initial: () => ({ record: null }),
});
// family 无枚举接口；调用索引同时用于重放去重与查找引用消息，终态保留以免旧调用再次申请。
const ApprovalIndexDoc = defineDoc<{ calls: Record<string, string> }>({
  kind: "cs.mcp.approval.index", version: 1, scope: "session", initial: () => ({ calls: {} }),
});
type Request = Omit<ApprovalCall, "code" | "args_digest" | "requested_at" | "expires_at" | "request_message_id">;
type Options = {
  getHarness(): Pick<Harness, "snapshot" | "commit">;
  owners(): OwnerIds; config: McpConfigState; send: Pick<SendService, "system">;
  input(key: string): InboundRecord | null;
  invoke(record: Extract<McpApproval, { state: "executing" }>): Promise<ToolExecutionResult>;
  now?: () => number;
};
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const text = (value: string, isError = false): ToolExecutionResult => ({ output: [{ type: "text", text: value }], ...(isError ? { isError } : {}) });
const singleLine = (value: string, max: number) => value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, max);

/** 宿主审批账本不运行模型；唯一执行入口由 PiMcp 注入，复用它的调用边界。 */
export class McpApprovals {
  constructor(private readonly opts: Options) {}
  private now() { return (this.opts.now ?? Date.now)(); }

  private event(kind: "requested" | "decided" | "executed", record: McpApproval, status: string): void {
    trace.event("@pi-mcp", `mcp_approval_${kind}`, { status, detail: {
      code: record.code, tool: record.tool, group: record.scope.slice(6), requester: record.requester,
      args_digest: record.args_digest, inputBytes: jsonBytes(record.args),
    } });
  }

  async records(): Promise<McpApproval[]> {
    const index = await this.opts.getHarness().snapshot(ApprovalIndexDoc, BACKGROUND_CONTEXT);
    const records = await Promise.all(Object.values(index?.calls ?? {}).map(code =>
      this.opts.getHarness().snapshot(McpApprovalDoc, code, BACKGROUND_CONTEXT)));
    return records.flatMap(doc => doc?.record ? [approvalSchema.parse(doc.record)] : []);
  }

  async request(input: Omit<Request, "requester_name">, inputKey?: string): Promise<ToolExecutionResult> {
    const source = inputKey ? this.opts.input(inputKey) : null;
    const requester_name = singleLine(source?.user_id === input.requester ? source.nickname : "", 80) || input.requester;
    const result = await this.opts.getHarness().commit(async tx => {
      const index = await tx.doc(ApprovalIndexDoc), key = digest([input.conversation_id, input.call_id]);
      const existing = index.calls[key];
      if (existing) return { record: approvalSchema.parse((await tx.doc(McpApprovalDoc, existing, existing)).record), created: false };
      const pending: McpApproval[] = [];
      for (const code of Object.values(index.calls)) {
        const record = (await tx.doc(McpApprovalDoc, code, code)).record;
        if (record?.state === "pending" && this.now() <= record.expires_at) pending.push(record);
      }
      if (pending.filter(r => r.scope === input.scope).length >= 5 || pending.filter(r => r.requester === input.requester).length >= 3) {
        return { record: null, created: false };
      }
      const used = new Set(Object.values(index.calls));
      let code: string;
      do { code = Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(""); } while (used.has(code));
      const requested_at = this.now();
      const record: McpApproval = { ...input, requester_name, code, args_digest: digest(input.args),
        requested_at, expires_at: requested_at + 30 * 60_000, state: "pending" };
      (await tx.doc(McpApprovalDoc, code, code)).record = record;
      index.calls[key] = code;
      return { record, created: true };
    }, BACKGROUND_CONTEXT);
    const record = result.record;
    if (!record) return text("待审批请求已达上限（每群 5 条、每人 3 条），请等待已有请求处理后再调用。", true);
    if (result.created) {
      this.event("requested", record, "pending");
      const owners = this.opts.owners(), owner = typeof owners === "string" ? owners : owners?.[0];
      const summary = redactText(singleLine(JSON.stringify(record.args), Infinity), 200);
      const sent = await this.send(record, `「待审批 #${record.code}」${record.requester_name}(${record.requester}) 请求 ${record.tool}：${summary}。引用本条回复「批准」或「拒绝」，30 分钟内有效。`, "request", owner);
      if (sent?.status === "sent" && sent.message_id) {
        await this.opts.getHarness().commit(async tx => {
          const doc = await tx.doc(McpApprovalDoc, record.code, record.code);
          if (doc.record) doc.record.request_message_id = sent.message_id!;
        }, BACKGROUND_CONTEXT);
        record.request_message_id = sent.message_id;
      }
    }
    return text(record.state === "pending"
      ? `已提交主人审批（#${record.code}），批准后系统自动执行并在本群通报结果；不要重复调用。${record.request_message_id ? "" : `审批通知未确认送达，主人仍可在本群 @机器人回复「批准 #${record.code}」或「拒绝 #${record.code}」。`}`
      : `审批 #${record.code} 已处理（${record.state}），不要重复调用。`);
  }

  /** 只接纳 Channel 已验证并放行的用户输入；consume 在网络调用前完成，绝不交给模型。 */
  async handle(rec: InboundRecord, consume: () => void): Promise<boolean> {
    if (rec.kind !== "user" || rec.message_type !== "group" || !isOwner(this.opts.owners(), rec.user_id) ||
      this.opts.config.kind !== "enabled" || !this.opts.config.value.servers.some(s => s.access.groups.includes(rec.scope.slice(6)))) return false;
    const value = rec.text.replace(/\[(?:reply|at)\]/gu, "").trim();
    const match = /^(批准|同意|通过|拒绝|驳回)\s*#?([A-Z0-9]{4})$/u.exec(value);
    const bare = /^(批准|同意|通过|拒绝|驳回)$/u.exec(value.replace(/\s/gu, ""));
    if (!match && !bare) return false;
    const records = (await this.records()).filter(r => r.scope === rec.scope);
    const record = match ? records.find(r => r.code === match[2])
      : rec.reply_to ? records.find(r => r.request_message_id === rec.reply_to) : undefined;
    if (!record) {
      if (!bare || rec.reply_to) return false;
      const pending = records.filter(r => r.state === "pending");
      if (!pending.length) return false;
      consume();
      for (const item of pending) this.event("decided", item, "ambiguous");
      await this.send(pending[0]!, "请引用待审批消息，或回复「批准 #编号」/「拒绝 #编号」。", `ambiguous:${rec.key}`, undefined, rec.key);
      return true;
    }
    const approve = !["拒绝", "驳回"].includes((match ?? bare)![1]!);
    const decision = await this.opts.getHarness().commit(async tx => {
      const doc = await tx.doc(McpApprovalDoc, record.code, record.code), current = doc.record;
      if (!current || current.state !== "pending") return { record: current ? approvalSchema.parse(current) : null, changed: false };
      const decided_at = this.now();
      doc.record = decided_at > current.expires_at ? { ...current, state: "expired", decided_at }
        : approve ? { ...current, state: "executing", decided_at, decided_by: rec.user_id, decision_input_key: rec.key }
        : { ...current, state: "rejected", decided_at };
      return { record: approvalSchema.parse(doc.record), changed: true };
    }, BACKGROUND_CONTEXT);
    consume();
    const current = decision.record;
    if (!current) return true;
    if (!decision.changed) {
      await this.send(current, `#${current.code} 已处理（${current.state}），不会重复执行。`, `repeat:${rec.key}`, current.requester, rec.key);
      return true;
    }
    this.event("decided", current, current.state === "executing" ? "approved" : current.state);
    if (current.state === "executing") await this.execute(current);
    else await this.send(current, `「#${current.code} ${current.state === "expired" ? "已过期" : "已拒绝"}」`, current.state, current.requester, rec.key);
    return true;
  }

  private async execute(record: Extract<McpApproval, { state: "executing" }>): Promise<void> {
    let state: "done" | "failed" | "unknown", summary: string;
    try {
      const result = await this.opts.invoke(record);
      state = result.diagnostics?.some(d => d.code === "mcp_outcome_unknown") ? "unknown" : result.isError ? "failed" : "done";
      summary = redactText(singleLine((result.output ?? []).flatMap(c => c.type === "text" ? [c.text] : []).join("\n"), Infinity), 500);
    } catch {
      state = "unknown"; summary = "执行结果未知，请用 workshop_status 核对；不要重复调用。";
    }
    const settled: McpApproval = { ...record, state, result_summary: summary };
    await this.opts.getHarness().commit(async tx => { (await tx.doc(McpApprovalDoc, record.code, record.code)).record = settled; }, BACKGROUND_CONTEXT);
    this.event("executed", settled, state);
    await this.report(settled);
  }

  /** 恢复只结算执行意图，绝不重试 unsafe 调用。 */
  async recover(): Promise<void> {
    for (const record of await this.records()) {
      if (record.state === "executing") {
        const unknown: McpApproval = { ...record, state: "unknown", result_summary: "执行结果未知，请用 workshop_status 核对；不要重复调用。" };
        await this.opts.getHarness().commit(async tx => { (await tx.doc(McpApprovalDoc, record.code, record.code)).record = unknown; }, BACKGROUND_CONTEXT);
        this.event("executed", unknown, "unknown");
        await this.report(unknown);
      } else if (record.state === "done" || record.state === "failed" || record.state === "unknown") {
        // 终态提交与通知跨库；稳定 Outbox 键补齐提交后崩溃的通知，已发消息不会重发。
        await this.report(record);
      }
    }
  }

  private report(record: Extract<McpApproval, { state: "done" | "failed" | "unknown" }>) {
    const label = record.state === "done" ? "已执行" : record.state === "failed" ? "执行失败" : "结果未知";
    return this.send(record, `「#${record.code} ${label}」${record.tool}：${record.result_summary}`, "result", record.requester, record.decision_input_key);
  }

  private async send(record: McpApproval, body: string, suffix: string, mention?: string, inputKey?: string) {
    try {
      return await this.opts.send.system({ threadKey: record.thread_key, scope: record.scope, inputKey }, body, [], {
        key: `${record.thread_key}:sys:mcp:${record.code}:${suffix}`, mention,
      });
    } catch { return undefined; }
  }
}

import { defineDoc, GenerationTask, InboxDoc, LiveDoc, UserEntry, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { z } from "zod";

const person = z.string().regex(/^[1-9][0-9]{0,19}$/);
export const piInputSchema = z.object({
  inboundKey: z.string().min(1),
  identity: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("user"), sender: person }),
    z.object({ kind: z.literal("scheduled"), creator: person }),
    z.object({ kind: z.literal("event"), source: z.string().min(1), creator: person }),
  ]),
});
export type PiInput = z.infer<typeof piInputSchema>;

/** 与输入、run 同一事务落盘；按 submission id 查身份，不能从宿主内存或模型正文推断。 */
export const PiInputDoc = defineDoc<{ submissions: Record<string, PiInput> }>({
  kind: "cs.pi.input", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ submissions: {} }),
});

/**
 * 宿主只在空闲会话开一条输入；使用公开 Tx/GenerationTask 原子创建入站、身份和 run。
 * Conversation.submit 不提供事务回调。事务内再次检查 run，避免与子 agent 汇报抢占。
 * 已有 requestId 只返回原提交，不用重放时的身份覆盖旧记录。
 */
export function submitPiInput(harness: Harness, conversationId: ConversationId, input: PiInput, content: string, mode: "followUp" | "steer" = "followUp") {
  return harness.commit(async tx => {
    const existing = await tx.submissionByRequest(conversationId, input.inboundKey);
    if (existing) return { first: existing.id, submitted: true };
    const live = await tx.doc(LiveDoc, conversationId);
    if (live.run && mode === "followUp") return { first: live.run.inputs[0]!, submitted: false };
    const inbox = await tx.doc(InboxDoc, conversationId);
    if (!live.run && inbox.items.length) throw new Error("Pi 空闲会话仍有待放置输入，拒绝越过队列");
    const identities = await tx.doc(PiInputDoc, conversationId);
    if (live.run) {
      const submission = await tx.createSubmission({ conversationId, requestId: input.inboundKey, type: "input", status: "queued" });
      identities.submissions[String(submission.id)] = input;
      inbox.items.push({ id: submission.id, mode: "steer", content });
      return { first: submission.id, submitted: true };
    }
    const entry = await tx.appendEntry(UserEntry, conversationId, { model: [{ role: "user", content, timestamp: Date.now() }] });
    const submission = await tx.createSubmission({ conversationId, requestId: input.inboundKey, type: "input", status: "placed", entry: entry.id });
    identities.submissions[String(submission.id)] = input;
    live.run = { taskId: await tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" }, conversationId }), inputs: [submission.id] };
    return { first: submission.id, submitted: true };
  }, BACKGROUND_CONTEXT);
}

import { CompactionTask, GenerationTask, CompactionEntry, ResetEntry, defineExtension, hook, type Harness, type ContextView } from "@earendil-works/pi-durable";
import type { Context, Message } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import { CompactionPlan, type ContextHead } from "./context-types";
import { messageKey, textOf } from "./snapshot";

export type ContextOrigin = { head?: ContextHead; tags: ReadonlyMap<string, { summary: boolean; phase?: "retained" | "added" }> };
const size = (messages: readonly Message[]) => messages.reduce((n, message) => n + (message.role === "system" ? 0 : textOf(message).length), 0);
const count = (messages: readonly Message[]) => messages.filter(message => message.role !== "system").length;
const PLAN_KEY = "context-monitor:compaction";

/** 只读引擎上下文，旁路记录一次压缩选择；失败不影响生成，也不替换任何模型消息。 */
export function contextSource(storage: DurableObjectStorage, harness: () => Harness) {
  let origin: ContextOrigin | undefined;
  const extension = defineExtension({ name: "cs.context-monitor", hooks: [
    hook(CompactionTask, { beforeCompact: async (selected, api, context) => {
      try {
        const conversation = await harness().conversation(api.conversationId, context);
        const view = await conversation?.context(context);
        if (!view) return;
        const retained = view.contributions.flatMap((messages, index) => {
          const entry = view.entries[index];
          return entry && entry.id >= selected.firstKept && entry.id !== view.head?.id ? [...messages] : [];
        });
        const plan: CompactionPlan = { firstKept: Number(selected.firstKept), selectedThrough: Math.max(...view.entries.map(entry => Number(entry.id))),
          startedAt: Date.now(), summarizedChars: size(selected.messages), summarizedMessages: count(selected.messages), retainedChars: size(retained), retainedMessages: count(retained) };
        await storage.put(PLAN_KEY, plan);
      } catch { console.error({ event: "context_compaction_capture_failed" }); }
    } }),
    hook(GenerationTask, { beforeRequest: async (request, api, context) => {
      origin = undefined;
      try {
        const conversation = await harness().conversation(api.conversationId, context);
        const view = await conversation?.context(context);
        if (!view) return;
        const saved = await storage.get(PLAN_KEY);
        origin = contextOrigin(view, request.messages, Check(CompactionPlan, saved) ? saved : undefined);
      } catch { console.error({ event: "context_origin_capture_failed" }); }
    } }),
  ] });
  return { extension, origin: (_input: Context) => origin };
}

export function contextOrigin(view: ContextView, messages: readonly Message[], plan?: CompactionPlan): ContextOrigin {
  const head = view.head, actual = new Set(messages.map(messageKey)), tags = new Map<string, { summary: boolean; phase?: "retained" | "added" }>();
  let capturedHead: ContextHead | undefined;
  // 后台摘要尚未出现在这次固定请求中时，不能提前标为已应用。
  const applied = CompactionEntry.is(head) && head.model?.some(message => actual.has(messageKey(message)));
  if (applied && head.head !== undefined) {
    const selected = plan?.firstKept === Number(head.head) ? plan : undefined;
    capturedHead = { kind: "compaction", id: Number(head.id), firstKept: Number(head.head), at: head.model?.[0]?.timestamp ?? 0,
      reason: head.data.reason, ...(selected ? { plan: selected } : {}) };
  } else if (ResetEntry.is(head)) capturedHead = { kind: "reset", id: Number(head.id) };
  view.contributions.forEach((contribution, index) => {
    const entry = view.entries[index];
    if (!entry) return;
    for (const message of contribution) {
      const key = messageKey(message);
      if (!actual.has(key)) continue;
      const summary = !!applied && entry.id === head?.id;
      tags.set(key, { summary, ...(!summary && capturedHead?.kind === "compaction" && capturedHead.plan
        ? { phase: Number(entry.id) <= capturedHead.plan.selectedThrough ? "retained" : "added" } : {}) });
    }
  });
  return { head: capturedHead, tags };
}

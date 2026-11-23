import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { ContextView } from "@earendil-works/pi-durable";
import type { ModelSelection } from "../settings";

/** 切换模型前触发预压缩的最小非系统对话 token 阈值，同时作为切换压缩保留尾部上下文的目标大小。 */
export const SWITCH_KEEP_RECENT_TOKENS = 2_000;

const EFFORTS = new Set<string>(["low", "medium", "high", "xhigh"]);

/** 从持久化的 AgentDoc 状态还原当前已生效的模型选择，避免 DO 冷启动覆盖原模型而跳过切模前压缩。 */
export function selectionFromAgent(
  state: { model?: { provider: string; modelId: string }; thinkingLevel: string },
  fallback: ModelSelection,
): { selection: ModelSelection; persisted: boolean } {
  if (!state.model) return { selection: fallback, persisted: false };
  const reasoningEffort = EFFORTS.has(state.thinkingLevel) ? state.thinkingLevel as NonNullable<ModelSelection["reasoningEffort"]> : undefined;
  return {
    persisted: true,
    selection: {
      provider: state.model.provider,
      id: state.model.modelId,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    },
  };
}

/** 仅在跨模型（provider 或 model id 变化）且除首部摘要与 system 外的对话超出阈值时执行切模前压缩。 */
export function shouldCompactBeforeSwitch(view: ContextView, current: ModelSelection, next: ModelSelection): boolean {
  if (current.provider === next.provider && current.id === next.id) return false;
  const start = view.head === undefined ? 0 : 1;
  let dialogueTokens = 0;
  let nonSystemEntries = 0;
  for (let i = start; i < view.contributions.length; i++) {
    let hasDialogue = false;
    for (const msg of view.contributions[i]!) {
      if (msg.role === "system") continue;
      dialogueTokens += estimateMessageTokens(msg);
      hasDialogue = true;
    }
    if (hasDialogue) nonSystemEntries++;
  }
  return nonSystemEntries >= 2 && dialogueTokens > SWITCH_KEEP_RECENT_TOKENS;
}

const CONVERSATION_OPEN = "<conversation>\n";
const CONVERSATION_CLOSE = "\n</conversation>";
const PRIOR_SUMMARY_RE = /^\[User\]: The conversation history before this point was compacted into the following summary:\n\n<summary>\n[\s\S]*?\n<\/summary>/;
const OMITTED_MARKER = "\n\n[... earlier conversation history omitted to fit summarization context window ...]\n\n";

/**
 * 兜底压缩输入长度：按中文最坏约 0.5–1 token/字符折算（每可用 token 最多保留 2 个字符），
 * 确保即使原 1M 模型失效改由 256K 模型兜底压缩、或工具调用参数极大时，摘要请求自身也不会爆窗口。
 */
export function clampCompactionContext(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Context {
  if (model.contextWindow <= 0) return context;
  const reserve = Math.max(options?.maxTokens ?? 0, 16_384) + 4_096;
  const budgetTokens = model.contextWindow - reserve;
  if (budgetTokens <= 4_096) return context;
  // 中文与紧凑 JSON 约 1~2 字符/token；按 2 字符/token 控制上限可同时兼顾中英文安全余量与 DO 内存边界。
  const maxTotalChars = Math.floor(budgetTokens * 2);

  let systemChars = 0;
  for (const msg of context.messages) {
    if (msg.role === "system") {
      systemChars += typeof msg.content === "string" ? msg.content.length : JSON.stringify(msg.content).length;
    }
  }

  let changed = false;
  const messages = context.messages.map(msg => {
    if (msg.role !== "user" || typeof msg.content === "string") return msg;
    const blocks = msg.content.map(block => {
      if (block.type !== "text") return block;
      const maxPromptChars = Math.max(4_096, maxTotalChars - systemChars);
      if (block.text.length <= maxPromptChars) return block;
      const openIdx = block.text.indexOf(CONVERSATION_OPEN);
      const closeIdx = block.text.lastIndexOf(CONVERSATION_CLOSE);
      if (openIdx < 0 || closeIdx <= openIdx + CONVERSATION_OPEN.length) {
        changed = true;
        return { ...block, text: block.text.slice(block.text.length - maxPromptChars) };
      }
      const prefix = block.text.slice(0, openIdx + CONVERSATION_OPEN.length);
      const suffix = block.text.slice(closeIdx);
      const body = block.text.slice(openIdx + CONVERSATION_OPEN.length, closeIdx);
      const bodyBudget = maxPromptChars - prefix.length - suffix.length - OMITTED_MARKER.length;
      if (bodyBudget <= 1_024) return block;

      const priorMatch = PRIOR_SUMMARY_RE.exec(body);
      const headSummary = priorMatch && priorMatch[0].length <= Math.floor(bodyBudget * 0.35) ? priorMatch[0] : "";
      const tailBudget = bodyBudget - headSummary.length;
      let tail = body.slice(Math.max(headSummary.length, body.length - tailBudget));
      const boundary = tail.indexOf("\n\n[");
      if (boundary > 0 && boundary < Math.floor(tail.length * 0.25)) tail = tail.slice(boundary + 2);

      changed = true;
      const clampedBody = headSummary ? `${headSummary}${OMITTED_MARKER}${tail}` : `${OMITTED_MARKER.trimStart()}${tail}`;
      return { ...block, text: `${prefix}${clampedBody}${suffix}` };
    });
    return changed ? { ...msg, content: blocks } : msg;
  });

  return changed ? { ...context, messages } : context;
}

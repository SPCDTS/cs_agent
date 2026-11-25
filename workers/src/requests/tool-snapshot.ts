import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { boundedText, safeText } from "./snapshot";
import type { StepItem, StepStatus } from "./tool-types";

const STEP_STATUSES = new Set<StepStatus>(["pending", "in_progress", "done", "skipped", "failed"]);

/** 提取 update_steps 的步骤快照；严格先凭据脱敏再按长度截断，防止截断破坏敏感模式识别。 */
export function extractStepsSnapshot(name: string, args: unknown): StepItem[] | undefined {
  if (name !== "update_steps" || !args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const rawSteps = (args as { steps?: unknown }).steps;
  if (!Array.isArray(rawSteps) || rawSteps.length > 12) return undefined;
  const out: StepItem[] = [];
  for (const entry of rawSteps) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const { title, status } = entry as { title?: unknown; status?: unknown };
    if (typeof title !== "string" || typeof status !== "string" || !STEP_STATUSES.has(status as StepStatus)) return undefined;
    const redacted = safeText(title).replace(/\s+/g, " ").trim();
    if (!redacted) return undefined;
    out.push({ title: redacted.slice(0, 120), status: status as StepStatus });
  }
  return out;
}

export function argumentPreview(args: Record<string, unknown>): string | undefined {
  const raw = JSON.stringify(args);
  if (safeText(raw) !== raw) return "含凭据的参数已隐藏";
  if (Array.isArray(args.steps)) {
    const items = extractStepsSnapshot("update_steps", args);
    if (items) {
      if (!items.length) return "清空步骤清单";
      const done = items.filter(s => s.status === "done" || s.status === "skipped").length;
      const current = items.find(s => s.status === "in_progress") ?? items.find(s => s.status === "pending") ?? items.at(-1);
      return `${done}/${items.length} 步` + (current ? ` · ${current.title}` : "").slice(0, 140);
    }
  }
  const values = ["path", "command", "query", "url", "envId", "repository", "owner", "repo"]
    .flatMap(key => typeof args[key] === "string" ? [key + ": " + args[key]] : []).slice(0, 2);
  return values.length ? values.join(" · ").replace(/\s+/g, " ").slice(0, 160) : undefined;
}

/** 结构化输出仅用于执行详情；图片、音频及资源二进制不进入日志，也不回填模型上下文。 */
export function toolResultSnapshot(result: ToolExecutionResult) {
  const output = result.output?.map(part => part.type === "text" ? part.text : "[图片内容省略]").join("\n");
  const diagnostics = result.diagnostics?.map(item => item.message).join("\n");
  const structured = result.structuredOutput === undefined ? undefined : JSON.stringify(result.structuredOutput, (key, value: unknown) => {
    if (typeof value === "string" && (/^(blob|base64|image_base64|audio_base64)$/i.test(key) || /^data:[^,]*;base64,/i.test(value))) return "[二进制内容省略]";
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if ("type" in value && ["image", "audio"].includes(String(value.type)) || "mimeType" in value && ("data" in value || "blob" in value)) return "[二进制或资源内容省略]";
    }
    return value;
  }, 2);
  return { result: boundedText(output || diagnostics || (structured === undefined ? "[工具未提供结果正文]" : "")),
    ...(structured === undefined ? {} : { structuredResult: boundedText(structured) }) };
}

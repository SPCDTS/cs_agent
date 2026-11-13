import type { ToolHookCall, ToolExecutionResult } from "@earendil-works/pi-durable";
import { boundedText, safeText } from "./snapshot";

export function argumentPreview(args: ToolHookCall["arguments"]): string | undefined {
  const raw = JSON.stringify(args);
  if (safeText(raw) !== raw) return "含凭据的参数已隐藏";
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

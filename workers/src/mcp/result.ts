import { copyJson } from "@earendil-works/chord";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpLimits } from "./config";
import { boundedJson, type compileMcpSchema } from "./schema";

export function mcpFailure(code: string): ToolExecutionResult {
  return { isError: true, output: [{ type: "text", text: `${code}：MCP 调用未成功。${["outcome_unknown", "result_rejected", "remote_error"].includes(code) ? "远端可能已执行，请先查询实际状态，不要自动重复。" : "请检查权限、登录或目录后再操作。"}` }] };
}
export function boundedMcpText(value: string): string {
  return value.length <= 8000 ? value : value.slice(0, 7970).replace(/[\uD800-\uDBFF]$/, "") + "\n[MCP 文本已截断至 8000 字以内]";
}
export function convertMcpResult(input: unknown, outputSchema: ReturnType<typeof compileMcpSchema> | undefined, limits: McpLimits): ToolExecutionResult {
  try {
    const parsed = CallToolResultSchema.safeParse(boundedJson(input, limits.messageBytes, limits.schemaDepth * 3 + 3));
    if (!parsed.success) return mcpFailure("result_rejected");
    const result = parsed.data, texts: string[] = [];
    const images: Extract<NonNullable<ToolExecutionResult["output"]>[number], { type: "image" }>[] = [];
    for (const content of result.content) {
      switch (content.type) {
        case "text": texts.push(content.text); break;
        case "image":
          if (/^image\/(png|jpeg|webp|gif)$/.test(content.mimeType) && /^[A-Za-z0-9+/]*={0,2}$/.test(content.data)
            && Buffer.byteLength(content.data, "base64") <= 4 * 1024 * 1024 && images.length < 4) {
            images.push({ type: "image", data: content.data, mimeType: content.mimeType });
          } else texts.push("[MCP 图片超出格式或大小限制]");
          break;
        case "resource": texts.push("text" in content.resource ? `[MCP 资料来源：${content.resource.uri}]\n${content.resource.text}` : "[MCP 二进制资源已省略]"); break;
        case "resource_link": texts.push(`[MCP 链接，未访问] ${content.uri}`); break;
        case "audio": texts.push("[MCP 音频已省略，未转写]"); break;
      }
    }
    let structuredOutput;
    if (result.structuredContent !== undefined) {
      const value = boundedJson(result.structuredContent, limits.structuredBytes, limits.schemaDepth * 3 + 3);
      if (outputSchema && !outputSchema.check(value)) return mcpFailure("result_rejected");
      structuredOutput = copyJson(value);
      texts.push("[MCP 结构化结果]\n" + JSON.stringify(value));
    } else if (outputSchema && !result.isError) return mcpFailure("result_rejected");
    return { output: [{ type: "text", text: boundedMcpText(texts.join("\n")) }, ...images], ...(result.isError ? { isError: true } : {}),
      ...(structuredOutput !== undefined ? { structuredOutput } : {}) };
  } catch { return mcpFailure("result_rejected"); }
}

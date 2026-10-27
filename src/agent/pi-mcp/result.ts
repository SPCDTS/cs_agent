import { copyJson, type JsonValue } from "@earendil-works/chord";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ToolDiagnostic, ToolExecutionResult } from "@earendil-works/pi-durable";
import { CallToolResultSchema, ReadResourceResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpLimits } from "./config.js";
import { boundedJson, type compileMcpSchema } from "./schema.js";

function rejected(limits: McpLimits, resource = false): ToolExecutionResult {
  return {
    isError: true,
    output: [{ type: "text", text: utf8Prefix(resource ? "result_rejected：远端资源响应格式或大小不符合契约"
      : "result_rejected：远端响应格式、schema 或大小不符合契约。操作可能已完成，请先查询实际状态，不要自动重复。", limits.textBytes) }],
    diagnostics: [{ severity: "error", code: "result_rejected", message: resource ? "MCP 资源结果已拒绝" : "MCP 结果已拒绝；远端操作可能已完成" }],
  };
}

export function boundedMcpText(text: string, limits: McpLimits, diagnostics: ToolDiagnostic[] = [], textBytes = Buffer.byteLength(text, "utf8")): string {
  if (textBytes <= limits.textBytes) return text;
  const marker = `\n[MCP 文本已截断；原始 ${textBytes} 字节]`;
  diagnostics.push({ severity: "warn", code: "text_truncated", message: `MCP 文本已截断；原始 ${textBytes} 字节` });
  return utf8Prefix(text, Math.max(0, limits.textBytes - Buffer.byteLength(marker, "utf8"))) + utf8Prefix(marker, limits.textBytes);
}

/** 同一响应的图片共用张数与解码预算，工具结果和资源响应使用相同校验。 */
function imageCollector(limits: McpLimits) {
  const images: ImageContent[] = [];
  let imageBytes = 0;
  return { images, add(data: string, mimeType: string): string | undefined {
    if (images.length >= limits.images) return "图片张数超过限额";
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mimeType)) return "图片格式不支持";
    if (data.length > Math.ceil(limits.imageBytes / 3) * 4 || data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data)) return "图片编码无效或超过单张限额";
    const bytes = Buffer.from(data, "base64");
    if (bytes.toString("base64") !== data || bytes.length > limits.imageBytes || imageBytes + bytes.length > limits.contentBytes) return "图片编码或解码总量超过限额";
    const size = imageSize(bytes, mimeType);
    if (!size || size.width < 1 || size.height < 1 || size.width > 16_384 || size.height > 16_384 || size.width * size.height > 40_000_000) return "图片内容、MIME 或尺寸无效";
    imageBytes += bytes.length;
    images.push({ type: "image", data, mimeType });
  } };
}

export function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.toString("utf8", 0, end);
}

/** 只读取有界图片头；尺寸上限防止压缩图片声明异常画布。 */
function imageSize(bytes: Buffer, mime: string): { width: number; height: number } | undefined {
  if (mime === "image/png" && bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.readUInt32BE(8) === 13 && bytes.toString("ascii", 12, 16) === "IHDR" && bytes.toString("ascii", bytes.length - 8, bytes.length - 4) === "IEND") {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mime === "image/gif" && bytes.length >= 14 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)) && bytes[bytes.length - 1] === 0x3b) {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (mime === "image/jpeg" && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) {
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset++] !== 0xff) return undefined;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) return undefined;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) return undefined;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return undefined;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
      }
      offset += length;
    }
  }
  if (mime === "image/webp" && bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" && bytes.readUInt32LE(4) + 8 === bytes.length) {
    const kind = bytes.toString("ascii", 12, 16);
    if (kind === "VP8X") return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    if (kind === "VP8L" && bytes[20] === 0x2f) return {
      width: 1 + (bytes.readUInt32LE(21) & 0x3fff), height: 1 + ((bytes.readUInt32LE(21) >>> 14) & 0x3fff),
    };
    if (kind === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) return {
      width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  return undefined;
}

/** 收到响应后只做纯转换；不重试、不取资源，也不回传第三方错误栈。 */
export function convertMcpResult(input: unknown, outputSchema: ReturnType<typeof compileMcpSchema> | undefined, limits: McpLimits): ToolExecutionResult {
  try {
    const parsed = CallToolResultSchema.safeParse(boundedJson(input, limits.messageBytes, limits.schemaDepth * 3 + 3));
    if (!parsed.success) return rejected(limits);
    const result = parsed.data;
    const texts: string[] = [];
    const collector = imageCollector(limits), { images } = collector;
    const diagnostics: ToolDiagnostic[] = [];
    function omitted(message: string): void {
      texts.push(`[MCP 内容省略：${message}]`);
      if (diagnostics.length < 16) diagnostics.push({ severity: "warn", code: "content_omitted", message });
    }
    for (const content of result.content) {
      switch (content.type) {
        case "text": texts.push(content.text); break;
        case "resource_link":
          texts.push("[MCP 资源链接，未访问] " + JSON.stringify({ uri: content.uri, name: content.name, mimeType: content.mimeType, description: content.description }));
          break;
        case "resource":
          if ("text" in content.resource) texts.push(`[MCP 资料来源：${content.resource.uri}]\n${content.resource.text}`);
          else omitted("内嵌二进制资源，未解码或访问");
          break;
        case "audio": omitted("音频，未转写"); break;
        case "image": {
          const reason = collector.add(content.data, content.mimeType);
          if (reason) omitted(reason);
          break;
        }
        default: { const exhaustive: never = content; return exhaustive; }
      }
    }
    let structuredOutput: JsonValue | undefined;
    if (result.structuredContent !== undefined) {
      const structured = copyJson(result.structuredContent);
      const json = JSON.stringify(structured);
      if (Buffer.byteLength(json, "utf8") > limits.structuredBytes || (outputSchema && !outputSchema.check(structured))) return rejected(limits);
      if (outputSchema) structuredOutput = structured;
      texts.push("[MCP 结构化结果]\n" + json);
    } else if (outputSchema && !result.isError) return rejected(limits);
    if (result.isError) diagnostics.push({ severity: "warn", code: "remote_error", message: "远端返回错误；错误不保证操作没有副作用" });
    const boundedText = boundedMcpText(texts.join("\n"), limits, diagnostics);
    const output: (TextContent | ImageContent)[] = boundedText ? [{ type: "text", text: boundedText }, ...images] : [...images];
    return { output, ...(structuredOutput !== undefined ? { structuredOutput } : {}), ...(result.isError ? { isError: true } : {}), ...(diagnostics.length ? { diagnostics } : {}) };
  } catch { return rejected(limits); }
}

/** 资源只作为有来源的资料；不执行 HTML，也不跟随其中的 URI。 */
export function convertMcpResourceResult(input: unknown, limits: McpLimits): ToolExecutionResult {
  try {
    const parsed = ReadResourceResultSchema.safeParse(boundedJson(input, limits.messageBytes, limits.schemaDepth * 3 + 3));
    if (!parsed.success) return rejected(limits, true);
    const texts: string[] = [], diagnostics: ToolDiagnostic[] = [];
    const collector = imageCollector(limits);
    for (const content of parsed.data.contents) {
      if ("text" in content) texts.push(`[MCP 资料来源：${content.uri}；${content.mimeType ?? "未声明"}]\n${content.text}`);
      else {
        const reason = collector.add(content.blob, content.mimeType ?? "");
        if (reason) {
          texts.push(`[MCP 内容省略：二进制资源 ${content.mimeType ?? "未声明"}，base64 ${Buffer.byteLength(content.blob)} 字节，未解码]`);
          if (diagnostics.length < 16) diagnostics.push({ severity: "warn", code: "content_omitted", message: reason });
        }
      }
    }
    if (!parsed.data.contents.length) texts.push("[MCP 资源为空]");
    const text = boundedMcpText(texts.join("\n"), limits, diagnostics);
    const output: (TextContent | ImageContent)[] = [...text ? [{ type: "text" as const, text }] : [], ...collector.images];
    return { output, ...(diagnostics.length ? { diagnostics } : {}) };
  } catch { return rejected(limits, true); }
}

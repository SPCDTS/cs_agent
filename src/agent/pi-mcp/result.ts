import { copyJson, type JsonValue } from "@earendil-works/chord";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ToolDiagnostic, ToolExecutionResult } from "@earendil-works/pi-durable";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpLimits } from "./config.js";
import type { compileMcpSchema } from "./schema.js";

function rejected(limits: McpLimits): ToolExecutionResult {
  return {
    isError: true,
    output: [{ type: "text", text: utf8Prefix("result_rejected：远端响应格式、schema 或大小不符合契约。操作可能已完成，请先查询实际状态，不要自动重复。", limits.textBytes) }],
    diagnostics: [{ severity: "error", code: "result_rejected", message: "MCP 结果已拒绝；远端操作可能已完成" }],
  };
}

function boundedJson(input: unknown, limits: McpLimits): JsonValue {
  let estimated = 0;
  const active = new Set<object>();
  function visit(value: unknown, depth: number): void {
    if (depth > limits.schemaDepth * 3 + 3) throw new Error("depth");
    if (typeof value === "string") estimated += Buffer.byteLength(value, "utf8") + 2;
    else if (value === null || typeof value === "number" || typeof value === "boolean") estimated += 8;
    else if (typeof value === "object") {
      if (active.has(value)) throw new Error("cycle");
      active.add(value);
      for (const key of Reflect.ownKeys(value)) {
        if (Array.isArray(value) && key === "length") continue;
        if (typeof key !== "string") throw new Error("key");
        estimated += Buffer.byteLength(key, "utf8") + 4;
        if (estimated > limits.messageBytes * 2) throw new Error("size");
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) throw new Error("accessor");
        visit(descriptor.value, depth + 1);
      }
      active.delete(value);
    } else throw new Error("json");
    if (estimated > limits.messageBytes * 2) throw new Error("size");
  }
  visit(input, 0);
  const result = copyJson(input);
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > limits.messageBytes) throw new Error("size");
  return result;
}

function utf8Prefix(value: string, maxBytes: number): string {
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
    const parsed = CallToolResultSchema.safeParse(boundedJson(input, limits));
    if (!parsed.success) return rejected(limits);
    const result = parsed.data;
    const texts: string[] = [];
    const images: ImageContent[] = [];
    const diagnostics: ToolDiagnostic[] = [];
    let imageBytes = 0;
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
          if (images.length >= limits.images) { omitted("图片张数超过限额"); break; }
          if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(content.mimeType)) { omitted("图片格式不支持"); break; }
          if (content.data.length > Math.ceil(limits.imageBytes / 3) * 4 || content.data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(content.data)) { omitted("图片编码无效或超过单张限额"); break; }
          const bytes = Buffer.from(content.data, "base64");
          if (bytes.toString("base64") !== content.data || bytes.length > limits.imageBytes || imageBytes + bytes.length > limits.contentBytes) { omitted("图片编码或解码总量超过限额"); break; }
          const size = imageSize(bytes, content.mimeType);
          if (!size || size.width < 1 || size.height < 1 || size.width > 16_384 || size.height > 16_384 || size.width * size.height > 40_000_000) { omitted("图片内容、MIME 或尺寸无效"); break; }
          imageBytes += bytes.length;
          images.push({ type: "image", data: content.data, mimeType: content.mimeType });
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
    const text = texts.join("\n");
    const textBytes = Buffer.byteLength(text, "utf8");
    let boundedText = text;
    if (textBytes > limits.textBytes) {
      const marker = `\n[MCP 文本已截断；原始 ${textBytes} 字节]`;
      boundedText = utf8Prefix(text, Math.max(0, limits.textBytes - Buffer.byteLength(marker, "utf8"))) + utf8Prefix(marker, limits.textBytes);
      diagnostics.push({ severity: "warn", code: "text_truncated", message: `MCP 文本已截断；原始 ${textBytes} 字节` });
    }
    const output: (TextContent | ImageContent)[] = boundedText ? [{ type: "text", text: boundedText }, ...images] : [...images];
    return { output, ...(structuredOutput !== undefined ? { structuredOutput } : {}), ...(result.isError ? { isError: true } : {}), ...(diagnostics.length ? { diagnostics } : {}) };
  } catch { return rejected(limits); }
}

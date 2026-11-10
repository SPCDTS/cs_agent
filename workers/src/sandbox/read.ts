import { Buffer } from "node:buffer";
import { imageMime } from "../media/model";
import { SandboxError, type ReadResult, type SandboxClient } from "./client";

const decoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: false });
const encoder = new TextEncoder();

/** 容器文件与持久快照共用文本分段、图片识别和返回格式。 */
export function decodeFileRead(content: Uint8Array, options: NonNullable<Parameters<SandboxClient["readFile"]>[1]> = {}): ReadResult {
  const start = (options.offset ?? 1) - 1;
  if (!Number.isInteger(start) || start < 0 || options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) throw new SandboxError("invalid_request");
  const mimeType = imageMime(content);
  if (mimeType) return { kind: "image", data: Buffer.from(content).toString("base64"), mimeType };
  if (content.includes(0)) throw new SandboxError("binary_file");
  const lines = decoder.decode(content).split("\n");
  if (start >= lines.length) throw new SandboxError("offset_out_of_range");
  const end = Math.min(lines.length, start + (options.limit ?? lines.length)), taken: string[] = [];
  let size = 0;
  for (let at = start; at < end && taken.length < 2000; at++) {
    const line = lines[at], length = encoder.encode(line).byteLength + 1;
    if (size + length > 50 * 1024) { if (!taken.length) taken.push(decoder.decode(encoder.encode(line).subarray(0, 50 * 1024))); break; }
    taken.push(line); size += length;
  }
  return { text: taken.join("\n"), startLine: start + 1, endLine: start + taken.length, totalLines: lines.length };
}

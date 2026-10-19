import { redact, redactText } from '../../shared/redact.js';
import { SessionError, type Block, type ContentRef } from './types.js';

export const INLINE_BYTES = 8 * 1024;
export const RESPONSE_BYTES = 1024 * 1024;

/** 不使用通用 redact 的数组条数上限，避免悄悄丢失回合；每个字符串仍走同一脱敏器。 */
export function redactSessionValue(value: unknown, depth = 0): unknown {
  if (depth > 32) return '[深度上限]';
  if (typeof value === 'string') return redactText(value, Number.MAX_SAFE_INTEGER);
  if (Array.isArray(value)) return value.map(item => redactSessionValue(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const checked = redact({ [key]: item }, Number.MAX_SAFE_INTEGER) as Record<string, unknown>;
    const safeKey = redactText(key, 128);
    return [safeKey, checked[safeKey] === '[已隐藏]' ? '[已隐藏]' : redactSessionValue(item, depth + 1)];
  }));
  return value;
}

/** 正文先整体脱敏，再生成预览，防止凭据跨预览边界时漏出前半段。 */
export function inlineBlock(block: Block, ref: ContentRef): Block {
  if (block.text === undefined) return redactSessionValue(block) as Block;
  const text = redactText(block.text, Number.MAX_SAFE_INTEGER);
  if (Buffer.byteLength(block.text) <= INLINE_BYTES) return redactSessionValue({ ...block, text }) as Block;
  const { text: _text, ...rest } = block;
  return redactSessionValue({ ...rest, preview: redactText(text, 512), ref }) as Block;
}

export function validRange(ref: ContentRef, indexed: ContentRef): boolean {
  return ref.session === indexed.session && Number.isSafeInteger(ref.offset) && Number.isSafeInteger(ref.length)
    && ref.offset >= indexed.offset && ref.offset < indexed.offset + indexed.length
    && ref.length > 0 && Number.isSafeInteger(ref.offset + ref.length)
    // 固定步长的末块最多越界 3 字节；实际返回仍由正文长度截断。
    && ref.offset + ref.length - (indexed.offset + indexed.length) <= 3;
}

/** 切分 UTF-8 时保留完整字符；正文已整体脱敏，子范围不能绕过秘密匹配。 */
export function utf8Slice(text: string, offset: number, length: number): string {
  const buffer = Buffer.from(text);
  let start = Math.min(offset, buffer.length), end = Math.min(offset + length, buffer.length);
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
  // 跨边界字符归前一块；后一块的起点跳过续字节，因此既不丢失也不重复。
  while (end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end++;
  return buffer.subarray(start, end).toString('utf8');
}

export function contentSlice(text: string, ref: ContentRef, indexed: ContentRef): string {
  if (!validRange(ref, indexed)) throw new SessionError(400, '范围不在已索引的正文块内');
  return utf8Slice(redactText(text, Number.MAX_SAFE_INTEGER), ref.offset - indexed.offset, ref.length);
}

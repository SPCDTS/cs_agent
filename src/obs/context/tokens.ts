import { redactText } from '../../shared/redact.js';
import { utf8Slice } from '../sessions/content.js';
export { safeBody } from '../sessions/content.js';

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** js-tiktoken 对无空格的长串（如中文）按段耗时近似平方：8 KiB 一段约 3 s，512 字节一段总耗时降约 16 倍，计数误差约 0.3%。 */
const SEGMENT_BYTES = 512;
export const TOKEN_NOTE = '估算针对脱敏后的可见正文，使用本地 o200k_base；每条消息包含角色 token 与约 4 token 开销。单条正文最多 2 MiB；长文本按 512 字节分段，图片、音频和加密正文不计为 0，而标记不可用。';
type Encoder = { encode(text: string, allowed?: 'all' | string[], disallowed?: 'all' | string[]): number[] };
let encoder: Promise<Encoder | undefined> | undefined;
/** lite 与词表都是运行时本地依赖；只创建一次 encoder，不访问 CDN。 */
function getEncoder(): Promise<Encoder | undefined> {
  return encoder ??= Promise.all([import('js-tiktoken/lite'), import('js-tiktoken/ranks/o200k_base')])
    .then(([{ Tiktoken }, ranks]) => new Tiktoken(ranks.default)).catch(() => undefined);
}
export async function tokenizerName(): Promise<string> { return await getEncoder() ? 'o200k_base' : 'characters/3.5 (fallback)'; }

export async function estimateTokens(body: string, role = ''): Promise<{ tokens: number; truncated: boolean }> {
  const text = utf8Slice(body, 0, MAX_BODY_BYTES), enc = await getEncoder();
  let tokens = 4;
  if (enc) {
    tokens += enc.encode(role, [], []).length;
    // 分段限制重复字符等病态输入的 BPE 成本；边界误差属于估算假设。
    const bytes = Buffer.from(text);
    for (let start = 0; start < bytes.length;) {
      let end = Math.min(start + SEGMENT_BYTES, bytes.length);
      while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
      tokens += enc.encode(bytes.subarray(start, end).toString('utf8'), [], []).length;
      start = end;
    }
  } else tokens += Math.ceil((text.length + role.length) / 3.5);
  return { tokens, truncated: Buffer.byteLength(body) > MAX_BODY_BYTES };
}
export const preview = (text: string, max = 240): string => redactText(text, max);

import { formatMessage, formatMessageFull, formatSummary, type FormatOptions } from '../context/format.js';
import type { ContextItem, MessageRow } from '../context/store.js';
import type { RecallHit } from '../obs/memory/instrumentation.js';

const ref = (item: ContextItem): RecallHit => item.kind === 'message'
  ? { kind: 'message', id: item.row.message_id } : { kind: 'summary', id: item.row.id };

/** 按实际格式化行匹配并消耗重复行；recent 从末尾匹配，保留正确的同文消息。 */
export function returnedLines(items: ContextItem[], output: string, fmt: FormatOptions, keep: 'first' | 'last'): RecallHit[] {
  const lines = output.split('\n'), used = new Set<number>(), found: { at: number; hit: RecallHit }[] = [];
  for (const item of keep === 'last' ? [...items].reverse() : items) {
    const line = item.kind === 'message' ? formatMessage(item.row, fmt) : formatSummary(item.row, fmt);
    const indices = lines.map((_, i) => i);
    const at = (keep === 'last' ? indices.reverse() : indices).find(i => !used.has(i) && lines[i] === line);
    if (at !== undefined) { used.add(at); found.push({ at, hit: ref(item) }); }
  }
  return found.sort((a, b) => a.at - b.at).map(v => v.hit);
}

/** 全文工具可能裁剪到某条正文或引用中间：只要该条的文本进入结果就计入。图片分支只保留完整条目。 */
export function returnedMessage(hit: { row: MessageRow; chain: MessageRow[] }, output: string, fmt: FormatOptions): RecallHit[] {
  const chunks = [formatMessageFull({ row: hit.row, chain: [] }, fmt, Infinity),
    ...hit.chain.map((row, i) => `${'  '.repeat(i + 1)}↳ 引用 ${formatMessage(row, fmt)}`)];
  const full = chunks.join('\n'), rows = [hit.row, ...hit.chain];
  const prefixLength = output.endsWith('…') && full.startsWith(output.slice(0, -1)) ? output.length - 1 : undefined;
  let offset = 0, cursor = 0;
  return chunks.flatMap((chunk, i) => {
    const at = output.indexOf(chunk, cursor);
    const included = prefixLength === undefined ? at !== -1 : offset < prefixLength;
    if (at !== -1) cursor = at + chunk.length;
    offset += chunk.length + 1;
    return included ? [{ kind: 'message' as const, id: rows[i].message_id }] : [];
  });
}

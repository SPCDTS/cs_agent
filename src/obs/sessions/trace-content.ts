import path from 'node:path';
import { safeBody } from './content.js';
import { smallJson } from './files.js';
import { SessionError, type TraceContentRef } from './types.js';

export const TRACE_PAYLOAD_PATH = /^payloads\/[A-Za-z0-9_.-]+\.json$/;

/** bundle 必须属于本会话；仅允许已约定的正文节点，不开放任意 JSON 指针。 */
export function validateTraceRef(id: string, ref: TraceContentRef): void {
  const suffix = '-' + id;
  if (!ref.bundle.endsWith(suffix) || !/^trace-[A-Za-z0-9-]+$/.test(ref.bundle.slice(0, -suffix.length))
    || /[\\/\x00-\x1f\x7f]/.test(ref.bundle))
    throw new SessionError(400, 'trace bundle 不属于本会话或名称无效');
  if (!TRACE_PAYLOAD_PATH.test(ref.payload) || /[\r\n]/.test(ref.payload))
    throw new SessionError(400, 'trace payload 路径无效');
  if (!/^\/(instructions|tools\/\d+|input\/\d+|output_items\/\d+)$/.test(ref.select) || /[\r\n]/.test(ref.select))
    throw new SessionError(400, 'trace select 无效');
}

export async function readTraceContent(home: string, id: string, ref: TraceContentRef): Promise<string> {
  validateTraceRef(id, ref);
  const root = path.resolve(home, 'trace');
  let payload: unknown;
  try { payload = await smallJson(root, path.join(root, ref.bundle, ref.payload)); }
  catch { throw new SessionError(404, 'trace 负载不存在或不可读取'); }
  const [, field, rawIndex] = ref.select.split('/');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Object.hasOwn(payload, field!))
    throw new SessionError(404, 'trace 正文节点不存在');
  let node = (payload as Record<string, unknown>)[field!];
  if (rawIndex !== undefined) {
    const index = Number(rawIndex);
    if (!Array.isArray(node) || !Number.isSafeInteger(index) || index >= node.length)
      throw new SessionError(404, 'trace 正文索引不存在');
    node = node[index];
  }
  return typeof node === 'string' ? node : safeBody(node);
}

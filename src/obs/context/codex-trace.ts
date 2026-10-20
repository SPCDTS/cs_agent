import { promises as fs } from 'node:fs';
import path from 'node:path';
import { rolloutLines } from '../sessions/codex-adapter.js';
import { TRACE_PAYLOAD_PATH } from '../sessions/trace-content.js';
import type { TraceContentRef } from '../sessions/types.js';
import { codexMessage, num, object, str } from './codex-history.js';
import { localFile, smallJson } from './files.js';
import { estimateTokens, preview, safeBody } from './tokens.js';
import type { ContextAnalysis, HistoryMessage } from './types.js';

type Attempt = { id: string; turn: string; thread: string; at: number; request: unknown; response?: unknown; completed?: number };
export type TraceContext = { messages: HistoryMessage[]; measured?: ContextAnalysis['measured']; at: number; completed?: number; notes: string[] };

/** 按官方 v1 bundle 的 manifest / trace.jsonl / payloads 读取；未知布局一律回退。 */
export async function readCodexTrace(home: string, session: string, turn: string | undefined, phase: 'before' | 'after'): Promise<TraceContext | undefined> {
  if (!turn) return undefined;
  const root = path.resolve(home, 'trace');
  try {
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return undefined;
    const bundles: string[] = [];
    let visited = 0;
    async function visit(dir: string, depth: number): Promise<void> {
      if (depth > 4 || visited >= 4096) return;
      for (const item of await fs.readdir(dir, { withFileTypes: true })) {
        if (++visited > 4096) return;
        if (item.isSymbolicLink()) continue;
        const file = path.join(dir, item.name);
        if (item.isFile() && item.name === 'manifest.json') bundles.push(file);
        else if (item.isDirectory() && item.name !== 'payloads') await visit(file, depth + 1);
      }
    }
    await visit(root, 0);
    const candidates: Array<{ bundle: string; attempts: Attempt[]; selected: Attempt }> = [];
    for (const file of bundles) {
      try {
        const manifest = object(await smallJson(root, file, 64 * 1024));
        if (manifest.schema_version !== 1 || manifest.raw_event_log !== 'trace.jsonl') continue;
        const bundle = path.dirname(file), attempts: Attempt[] = [], byId = new Map<string, Attempt>();
        let previous = -1, valid = true;
        for await (const line of rolloutLines(await localFile(root, path.join(bundle, 'trace.jsonl')))) {
          if (!line.text) { valid = false; break; }
          let event: Record<string, unknown>;
          try { event = object(JSON.parse(line.text)); } catch { if (line.partial) break; valid = false; break; }
          if (event.schema_version !== 1 || num(event.seq) === undefined || Number(event.seq) <= previous) { valid = false; break; }
          previous = Number(event.seq);
          const p = object(event.payload), id = str(p.inference_call_id);
          if (!id) continue;
          if (p.type === 'inference_started') {
            const attempt = { id, turn: str(p.codex_turn_id) ?? str(event.codex_turn_id) ?? '',
              thread: str(p.thread_id) ?? str(event.thread_id) ?? '', at: num(event.wall_time_unix_ms) ?? 0, request: p.request_payload };
            attempts.push(attempt); byId.set(id, attempt);
          } else if (p.type === 'inference_completed') {
            const attempt = byId.get(id);
            if (attempt) { attempt.response = p.response_payload; attempt.completed = num(event.wall_time_unix_ms); }
          }
        }
        if (!valid) continue;
        const matching = attempts.filter(a => a.thread === session && a.turn === turn);
        const selected = phase === 'before' ? matching[0] : matching.at(-1);
        if (selected) candidates.push({ bundle, attempts, selected });
      } catch { /* 损坏、超限或未知 bundle 不影响其它 bundle。 */ }
    }
    candidates.sort((a, b) => a.selected.at - b.selected.at);
    const candidate = phase === 'before' ? candidates[0] : candidates.at(-1);
    if (!candidate) return undefined;
    const { bundle, selected, attempts } = candidate;
    const payloadName = (ref: unknown) => {
      const name = str(object(ref).path);
      if (!name || !TRACE_PAYLOAD_PATH.test(name) || /[\r\n]/.test(name)) throw new Error('unknown payload path');
      return name;
    };
    const payload = async (ref: unknown) => object(await smallJson(root, path.join(bundle, payloadName(ref))));
    const reference = (ref: unknown, select: string): TraceContentRef => ({ bundle: path.basename(bundle), payload: payloadName(ref), select });
    const entries = (items: unknown[], ref: unknown, field: string) => items.map((raw, index) => ({ raw, traceRef: reference(ref, `/${field}/${index}`) }));
    const request = await payload(selected.request);
    if (!Array.isArray(request.input)) return undefined;
    let input = entries(request.input, selected.request, 'input');
    if (request.previous_response_id) {
      // 增量传输不能冒充完整窗口；沿 response_id 回溯同线程请求链。
      const seen = new Set<string>();
      let previousId = str(request.previous_response_id);
      while (previousId) {
        if (seen.has(previousId) || seen.size >= 32) return undefined;
        seen.add(previousId);
        let parent: { request: Record<string, unknown>; response: Record<string, unknown>; attempt: Attempt } | undefined;
        for (const attempt of attempts.filter(a => a.thread === session && a.at < selected.at && a.response).reverse()) {
          const response = await payload(attempt.response);
          if (response.response_id === previousId) { parent = { response, request: await payload(attempt.request), attempt }; break; }
        }
        if (!parent || !Array.isArray(parent.request.input) || !Array.isArray(parent.response.output_items)) return undefined;
        input = [...entries(parent.request.input, parent.attempt.request, 'input'),
          ...entries(parent.response.output_items, parent.attempt.response, 'output_items'), ...input];
        previousId = str(parent.request.previous_response_id);
      }
    }
    const messages: HistoryMessage[] = [];
    if (typeof request.instructions === 'string' && request.instructions) {
      const item = await codexMessage({ type: 'message', role: 'system', content: request.instructions });
      if (item) messages.push({ ...item, traceRef: reference(selected.request, '/instructions') });
    }
    if (request.tools !== undefined && !Array.isArray(request.tools)) return undefined;
    for (const [index, tool] of ((request.tools as unknown[] | undefined) ?? []).entries()) {
      const body = safeBody(tool), count = await estimateTokens(body, 'tool');
      messages.push({ kind: 'tool_definition', category: 'tools', provenance: 'recorded', preview: preview(body),
        tokens: { estimated: count.tokens }, truncated: count.truncated, traceRef: reference(selected.request, `/tools/${index}`) });
    }
    for (const { raw, traceRef } of input) {
      const item = await codexMessage(raw);
      if (item) messages.push({ ...item, traceRef });
    }
    const response = selected.response ? await payload(selected.response) : undefined;
    if (phase === 'after') {
      if (!response || !Array.isArray(response.output_items)) return undefined;
      for (const [index, raw] of response.output_items.entries()) {
        const item = await codexMessage(raw, { ts: selected.completed });
        if (item) messages.push({ ...item, traceRef: reference(selected.response, `/output_items/${index}`) });
      }
    }
    const usage = object(response?.token_usage), inputTokens = num(usage.input_tokens);
    return { messages, at: selected.at, completed: selected.completed,
      measured: inputTokens === undefined ? undefined : { input: inputTokens, cached: num(usage.cached_input_tokens),
        at: selected.completed ?? selected.at, stale: false, source: 'codex.trace.token_usage' },
      notes: ['官方 trace v1 的请求负载已读取；after 在最后请求的输入上追加已记录输出，实测值仍是该请求的 input。'] };
  } catch { return undefined; }
}

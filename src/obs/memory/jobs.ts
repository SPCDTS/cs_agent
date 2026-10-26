/**
 * 画像编辑与夜间整理的面板接口（docs/DASHBOARD.md §8.6、docs/MEMORY-DESIGN.md §9、§10）：
 * - GET /api/memory/profile/<ns>、GET /api/memory/jobs（经 memory/http.ts 的只读路由，统一脱敏）；
 * - POST /api/memory/profile/<ns>（{text, revision}，CAS；revision 不符 409 并带当前内容）、
 *   POST /api/memory/proposals/<id>/{accept,reject}、POST /api/memory/consolidate/run、POST /api/memory/consolidate/<batch_id>/rollback。
 * 写接口与 /api/memory/entries 的遗忘 / 恢复同一套约束（同源、application/json、CSRF）。表单页面（dashboard-post.ts）共用这里的动作函数。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ProfileError } from '../../context/memory/profile.js';
import { MemoryStoreError } from '../../context/memory/store.js';
import { PROFILE_MAX_BYTES, isMemoryNs } from '../../context/memory/types.js';
import { scopeLabel } from '../../context/access.js';
import { redactText } from '../../shared/redact.js';
import { log } from '../../shared/log.js';
import { HttpError } from '../dashboard-io.js';
import { sessionJson } from '../sessions/http.js';
import { SessionError } from '../sessions/types.js';
import { readMemoryJsonPost } from './entries.js';
import type { MemoryExtractSource, MemoryJobsSource, MemoryJobsStatus, MemoryProfileView, MemoryProposalView } from './types.js';

export const MEMORY_PROFILE_PATH = /^\/api\/memory\/profile\/([^/]+)$/;
export const MEMORY_PROPOSAL_ACTION = /^\/api\/memory\/proposals\/([1-9]\d{0,15})\/(accept|reject)$/;
export const MEMORY_CONSOLIDATE_RUN = '/api/memory/consolidate/run';
export const MEMORY_CONSOLIDATE_ROLLBACK = /^\/api\/memory\/consolidate\/([^/]+)\/rollback$/;

const nsLabel = (src: MemoryJobsSource, ns: string) => ns === 'owner' ? 'owner 私聊' : src.scopeLabel?.(ns) ?? scopeLabel(ns);

/** 路径里的命名空间：URL 编码的 owner / group:<id> / private:<qq>，其余 400。 */
export function profileNs(raw: string): string {
  let ns: string;
  try { ns = decodeURIComponent(raw); } catch { throw new SessionError(400, '路径编码无效'); }
  if (!isMemoryNs(ns)) throw new SessionError(400, 'ns 必须是 owner、group:<群号> 或 private:<QQ号>');
  return ns;
}

/** GET /api/memory/profile/<ns>：当前画像与 revision；不存在为空文本、revision none。 */
export async function memoryProfileView(src: MemoryJobsSource, ns: string): Promise<MemoryProfileView> {
  const snap = await src.profiles.read(ns);
  return { ns, ns_label: nsLabel(src, ns), text: snap.text, revision: snap.revision, updated_at: snap.updatedAt,
    bytes: Buffer.byteLength(snap.text, 'utf8'), max_bytes: PROFILE_MAX_BYTES, oversize: snap.oversize === true,
    redacted_inside: redactText(snap.text, 1_000_000) !== snap.text };
}

/** GET /api/memory/jobs：抽取状态取自 /api/memory/extract 的同一来源。 */
export async function memoryJobsStatus(src: MemoryJobsSource, extract?: MemoryExtractSource): Promise<MemoryJobsStatus> {
  const proposals: MemoryProposalView[] = [];
  for (const p of src.consolidator.proposals()) {
    let current: MemoryProposalView['current'] = null;
    try { const snap = await src.profiles.read(p.ns); current = { text: snap.text, revision: snap.revision }; }
    catch (error) { log.warn('memory proposal: profile unreadable', { ns: p.ns, error }); }
    proposals.push({ id: p.id, ns: p.ns, ns_label: nsLabel(src, p.ns), text: p.text, based_on_revision: p.based_on_revision, batch_id: p.batch_id,
      created_at: p.created_at * 1000, current, stale: !current || current.revision !== p.based_on_revision });
  }
  return { extract: extract?.status() ?? null, consolidate: { ...src.consolidator.status(), next_run: src.nextRun() }, proposals,
    batches: src.store.consolidateBatches(10).map(b => ({ ...b, ns_label: nsLabel(src, b.ns), at: b.at * 1000 })) };
}

/** 记忆层错误 → HTTP 状态：不存在 404，已处理或已变更 409，其余（含凭据、超限、参数无效）400。 */
export function memoryJobError(error: unknown): HttpError | undefined {
  if (error instanceof HttpError) return error;
  if (error instanceof SessionError) return new HttpError(error.status, error.message);
  if (error instanceof MemoryStoreError) return new HttpError(error.code === 'not_found' ? 404 : error.code === 'conflict' ? 409 : 400, error.message);
  if (error instanceof ProfileError) return new HttpError(error.code === 'stale' ? 409 : 400, error.message);
  return undefined;
}

export type MemoryJobAction =
  | { kind: 'profile'; ns: string; text: string; revision: string }
  | { kind: 'proposal'; id: number; action: 'accept' | 'reject' }
  | { kind: 'run' }
  | { kind: 'rollback'; batchId: string };

/** 执行一个写动作（JSON 接口与表单共用）；返回给调用方的结果。 */
export async function applyMemoryJobAction(src: MemoryJobsSource, a: MemoryJobAction): Promise<Record<string, unknown>> {
  switch (a.kind) {
    case 'profile': return { ns: a.ns, ...(await src.saveProfile(a.ns, a.text, a.revision)) };
    case 'proposal':
      if (a.action === 'accept') return { id: a.id, status: 'accepted', ...(await src.consolidator.acceptProposal(a.id)) };
      await src.consolidator.rejectProposal(a.id); return { id: a.id, status: 'rejected' };
    case 'run': {
      const result = src.consolidator.trigger();
      if (result === 'disabled') throw new HttpError(409, '记忆整理已在设置页关闭');
      return { result };
    }
    case 'rollback': return { batch_id: a.batchId, ...src.consolidator.rollback(a.batchId) };
  }
}

/** 路径 → 动作；不是这组接口返回 undefined。 */
export function memoryJobAction(pathname: string, body: Record<string, unknown>): MemoryJobAction | undefined {
  const fields = (allowed: string[]) => { for (const k of Object.keys(body)) if (!allowed.includes(k)) throw new HttpError(400, '此操作不接受额外字段'); };
  const profile = MEMORY_PROFILE_PATH.exec(pathname);
  if (profile) {
    fields(['text', 'revision']);
    if (typeof body.text !== 'string' || typeof body.revision !== 'string' || !body.revision) throw new HttpError(400, 'text 与 revision 必须是字符串');
    return { kind: 'profile', ns: profileNs(profile[1]!), text: body.text, revision: body.revision };
  }
  const proposal = MEMORY_PROPOSAL_ACTION.exec(pathname);
  if (proposal) { fields([]); return { kind: 'proposal', id: Number(proposal[1]), action: proposal[2] as 'accept' | 'reject' }; }
  if (pathname === MEMORY_CONSOLIDATE_RUN) { fields([]); return { kind: 'run' }; }
  const rollback = MEMORY_CONSOLIDATE_ROLLBACK.exec(pathname);
  if (rollback) { fields([]); return { kind: 'rollback', batchId: rollback[1]! }; }
  return undefined;
}

export const isMemoryJobPost = (pathname: string) =>
  MEMORY_PROFILE_PATH.test(pathname) || MEMORY_PROPOSAL_ACTION.test(pathname) || pathname === MEMORY_CONSOLIDATE_RUN || MEMORY_CONSOLIDATE_ROLLBACK.test(pathname);

/** 画像 + 草稿 JSON 至多约 4 KiB 正文，转义后放宽到 64 KiB。 */
const BODY_MAX = 64 * 1024;

/** 画像、提议与整理的 JSON 写接口。画像 revision 不符为 409，并在 current 里带当前内容与 revision。 */
export function createMemoryJobActions(src: MemoryJobsSource | undefined, csrf: string) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL, host: string): Promise<void> => {
    let action: MemoryJobAction | undefined;
    try {
      if (!src) throw new HttpError(404, '记忆整理未启用');
      if (!isMemoryJobPost(url.pathname)) throw new HttpError(404, '接口不存在');
      action = memoryJobAction(url.pathname, await readMemoryJsonPost(req, host, csrf, BODY_MAX));
      if (!action) throw new HttpError(404, '接口不存在');
      const result = await applyMemoryJobAction(src, action);
      sessionJson(res, action.kind === 'run' ? 202 : 200, result);
    } catch (error) {
      const known = memoryJobError(error);
      if (!known) log.error('memory job action failed', { error });
      let current: { text: string; revision: string } | undefined;
      if (src && known?.status === 409 && action?.kind === 'profile') {
        try { const snap = await src.profiles.read(action.ns); current = { text: snap.text, revision: snap.revision }; } catch { /* 读不到就只给错误 */ }
      }
      sessionJson(res, known ? known.status : 500, { error: known ? known.message : '操作失败，详见日志', ...(current ? { current } : {}) });
    }
  };
}

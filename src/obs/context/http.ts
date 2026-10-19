import type { ServerResponse } from 'node:http';
import { analyzeContext, boundedContext, type ContextOptions } from './index.js';
import { segment, sessionJson, sessionLookup, type SessionAdapters } from '../sessions/http.js';
import { SessionError } from '../sessions/types.js';

/** 必须从 dashboard 已通过 cookie/Host 鉴权的分支调用。 */
export function createContextRoutes(adapters: SessionAdapters, contextOptions: ContextOptions = {}) {
  const { getAdapter, findSession } = sessionLookup(adapters);
  return async function handleContextRoute(url: URL, res: ServerResponse): Promise<void> {
    try {
      const p = url.pathname, q = url.searchParams;
      const parts = p.split('/');
      if (parts[1] !== 'api' || parts[2] !== 'agents' || parts[4] !== 'sessions') throw new SessionError(404, '接口不存在');
      const adapter = getAdapter(segment(parts[3] ?? ''));
      const id = segment(parts[5] ?? '');
      const found = await findSession(adapter, id);
      if (parts.length === 7 && parts[6] === 'context') {
        if (q.getAll('at').length > 1 || q.getAll('phase').length > 1) throw new SessionError(400, '上下文参数不可重复');
        const at = q.has('at') ? segment(q.get('at')!) : undefined;
        const phase = q.get('phase') ?? 'after';
        if (phase !== 'before' && phase !== 'after') throw new SessionError(400, 'phase 必须是 before 或 after');
        const analysis = boundedContext(await analyzeContext(adapters, found.session.backend, id, { ...contextOptions, at, phase }));
        // 固定契约的 key/tokens 已由引擎按字符串叶子脱敏，不能再当凭据字段遮蔽。
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(analysis)); return;
      }
      throw new SessionError(404, '接口不存在');
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      sessionJson(res, error instanceof SessionError ? error.status : 500,
        { error: error instanceof SessionError ? error.message : '会话读取暂不可用' });
    }
  };
}

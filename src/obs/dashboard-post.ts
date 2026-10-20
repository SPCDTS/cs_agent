/** 面板写操作：沿用同源、CSRF、版本检查与原有响应。 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DashboardOptions } from './dashboard-types.js';
import { equal, readBody, readMultipart, HttpError, guardAgentMd, writeAgentMd } from './dashboard-io.js';
import { SkillsStoreError } from '../agent/skills-store.js';
import { isThreadKey } from '../agent/codex/runner.js';
import { SETTINGS_TICKET, type RuntimeSettings } from '../agent/settings.js';
import { parseBackendOverrides } from '../agent/backends/select.js';
import { redactText } from '../shared/redact.js';
import type { Trace } from '../shared/trace.js';
import { page } from './ui/html.js';
import { log } from '../shared/log.js';

export function createDashboardPost(opts: DashboardOptions, csrf: string, agentMd: string,
  tracer: Pick<Trace, 'event'>,
  render: (url: URL, nonce: string, flash?: { text: string; error?: boolean }) => Promise<string | null>) {
  async function handlePost(req: IncomingMessage, res: ServerResponse, url: URL, nonce: string, host: string): Promise<void> {
    // 同源检查：Origin 为 null 时仅信任浏览器提供的 Sec-Fetch-Site: same-origin；其他 Origin 必须匹配，随后仍校验 CSRF 令牌。
    const origin = req.headers.origin;
    const site = req.headers['sec-fetch-site'];
    if (origin && origin !== `http://${host}` && !(origin === 'null' && site === 'same-origin')) { res.writeHead(403).end('跨站请求被拒绝'); return; }
    if (site && site !== 'same-origin' && site !== 'none') { res.writeHead(403).end('跨站请求被拒绝'); return; }
    let form: URLSearchParams;
    let file: Awaited<ReturnType<typeof readMultipart>>['file'];
    try {
      if (url.pathname === '/skills/upload') {
        const multipart = await readMultipart(req, { maxBytes: 20 * 1024 * 1024 });
        form = multipart.fields; file = multipart.file;
      } else form = await readBody(req);
    }
    catch (e) { res.writeHead(e instanceof HttpError ? e.status : 400).end(e instanceof Error ? e.message : ''); return; }
    if (!csrf || !equal(form.get('_csrf') ?? '', csrf)) { res.writeHead(403, {'Content-Type':'text/plain; charset=utf-8'}).end('CSRF 令牌无效，请刷新页面后重试'); return; }
    const back = (location: string) => res.writeHead(303, { Location: location }).end();
    try {
      if (url.pathname === '/skills/upload') {
        if (!opts.skills) throw new HttpError(404, '技能管理未启用');
        if (!file) throw new HttpError(400, '请选择技能文件');
        const overwrite = form.get('overwrite') === 'on';
        let detail: string;
        if (/\.zip$/i.test(file.name)) {
          const result = await opts.skills.importZip(file.data, { overwrite });
          detail = `导入 ${result.imported.length} 个：${result.imported.join('、') || '无'}。` +
            `跳过 ${result.skipped.length} 个：` + result.skipped.map(s => `${s.path}（${s.reason}）`).join('；');
        } else {
          let text: string;
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(file.data); }
          catch { throw new HttpError(400, 'SKILL.md 必须是 UTF-8 文本'); }
          const result = await opts.skills.importSkillMd(text, { overwrite });
          detail = `已导入 ${result.name}。`;
        }
        // 限制重定向头长度；批量结果保留总数，避免浏览器后续 GET 超过请求头上限。
        if (detail.length > 1200) detail = detail.slice(0, 1200) + '…（结果过长，已截断）';
        back('/skills?' + new URLSearchParams({ ok: 'skillsUploaded', detail })); return;
      }
      const deletion = /^\/skills\/([^/]+)\/delete$/.exec(url.pathname);
      if (deletion) {
        if (!opts.skills) throw new HttpError(404, '技能管理未启用');
        let name: string;
        try { name = decodeURIComponent(deletion[1]); } catch { throw new HttpError(400, '非法技能名称'); }
        await opts.skills.remove(name);
        back('/skills?ok=skillsDeleted'); return;
      }
      if (url.pathname === '/settings') {
        if (!opts.settings) throw new HttpError(404, '运行时设置不可用');
        let overrides: RuntimeSettings['backendOverrides'];
        try { overrides = parseBackendOverrides((form.get('backendOverrides') ?? '').split(/[\r\n,]+/).join(',')); }
        catch (e) { throw new HttpError(400, (e as Error).message.replace('AGENT_BACKEND_OVERRIDES', '覆盖表')); }
        try {
          await opts.settings.update({ agentBackend: form.get('agentBackend') as RuntimeSettings['agentBackend'], backendOverrides: overrides,
            codexReasoningEffort: form.get('codexReasoningEffort') as RuntimeSettings['codexReasoningEffort'],
            ...(form.has('codexModel') ? { codexModel: form.get('codexModel')! } : {}),
            ...(form.has('piModel') ? { piModel: form.get('piModel')! } : {}),
            ...(form.has('piThinkingLevel') ? { piThinkingLevel: form.get('piThinkingLevel') as RuntimeSettings['piThinkingLevel'] } : {}),
            alertOwner: form.get('alertOwner') === 'on' }, 'dashboard');
        } catch (e) { throw new HttpError(400, '设置未保存：取值不在允许范围内。' + ((e as { issues?: { path: unknown[] }[] }).issues?.map(i => i.path.join('.')).join('、') ?? '')); }
        back('/settings?ok=saved'); return;
      }
      if (url.pathname === '/settings/agent-md') {
        await guardAgentMd(agentMd, form.get('revision') ?? '');
        const r = await writeAgentMd(agentMd, form.get('content') ?? '');
        tracer.event(SETTINGS_TICKET, 'prompt_changed', { detail: { target: 'pi', source: 'dashboard', file: 'prompts/agent.md', bytes_before: r.before, bytes_after: r.after } });
        back('/settings?ok=prompt#prompt'); return;
      }
      if (url.pathname === '/settings/codex-base-prompt' || url.pathname === '/settings/codex-base-prompt/restore') {
        if (!opts.codexBasePrompt) throw new HttpError(404, 'codex 基础指令不可用');
        const model = form.get('model') ?? '';
        if (model !== (opts.settings?.current().codexModel ?? opts.config.CODEX_MODEL)) {
          throw new HttpError(409, '当前 codex 模型已改变，请刷新页面后再保存。');
        }
        try {
          const revision = form.get('revision') ?? '';
          if (url.pathname.endsWith('/restore')) await opts.codexBasePrompt.restore(model, revision);
          else await opts.codexBasePrompt.save(model, form.get('content') ?? '', revision);
        } catch (e) {
          throw new HttpError(409, redactText(e instanceof Error ? e.message : '基础指令未保存', 2_000));
        }
        back('/settings?ok=codexBasePrompt#codex-base-prompt'); return;
      }
      if (url.pathname === '/settings/codex-prompt') {
        if (!opts.codexPrompt) throw new HttpError(404, 'codex 系统提示不可用');
        try { await opts.codexPrompt.save((form.get('content') ?? '').replace(/\r\n?/g, '\n'), form.get('revision') ?? ''); }
        catch (e) {
          if ((e as Error)?.name === 'StaleRevisionError') throw new HttpError(409, 'codex.md 已在别处被修改，请刷新后再保存');
          throw new HttpError(409, redactText(e instanceof Error && e.message ? e.message : 'codex.md 未保存', 2_000));
        }
        back('/settings?ok=codexPrompt#codex-prompt'); return;
      }
      if (url.pathname === '/codex/compact' || url.pathname === '/pi/compact') {
        const codex = url.pathname === '/codex/compact';
        const key = form.get('key') ?? '';
        const compact = codex ? opts.compactCodex : opts.compactPi;
        if (!compact) throw new HttpError(404, '压缩不可用');
        if (!isThreadKey(key)) throw new HttpError(400, '非法的线程键');
        // 同步抛错和异步失败统一处理；超出 HTTP 等待窗口后仍有失败日志。
        const job = Promise.resolve().then(() => compact(key)).then(outcome => {
          if (outcome === 'compacted') tracer.event(codex ? '@codex' : '@pi', 'thread_compacted', {
            detail: { source: 'dashboard', backend: codex ? 'codex' : 'pi', [codex ? 'thread_key' : 'conversation_key']: key },
          });
          return outcome;
        }).catch(() => {
          // 后端错误可能含模型正文或凭据，只记操作与键。
          log.error('dashboard thread compaction failed', { backend: codex ? 'codex' : 'pi', key });
          return 'compactFailed' as const;
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const outcome = await Promise.race([job, new Promise<'compactQueued'>(resolve => {
            timer = setTimeout(() => resolve('compactQueued'), 1500).unref();
          })]);
          back(`/agents?ok=${outcome}`); return;
        } finally { clearTimeout(timer); }
      }
      if (url.pathname === '/codex/reset' || url.pathname === '/pi/reset') {
        const codex = url.pathname === '/codex/reset';
        const key = form.get('key') ?? '';
        const reset = codex ? opts.resetCodex : opts.resetPi;
        if (!reset) throw new HttpError(404, '重置不可用');
        if (!isThreadKey(key)) throw new HttpError(400, '非法的线程键');
        const job = (reset as (k: string) => Promise<string | number | null>)(key).then(old => {
          tracer.event(codex ? '@codex' : '@pi', 'thread_reset', { detail: { source: 'dashboard', backend: codex ? 'codex' : 'pi', [codex ? 'thread_key' : 'conversation_key']: key, archived: old } });
          return old;
        });
        // 进行中的回合可能还要几分钟：最多等 1.5 秒，否则告诉用户已排队。
        const outcome = await Promise.race([job.then(old => old === null ? 'unchanged' : 'reset'), new Promise<string>(r => setTimeout(() => r('queued'), 1500).unref())]);
        job.catch(() => undefined);
        back(`/agents?ok=${outcome}`); return;
      }
      throw new HttpError(404, '没有这个操作');
    } catch (e) {
      const expected = e instanceof HttpError || e instanceof SkillsStoreError;
      const status = expected ? e.status : 500;
      const message = expected ? e.message : '操作失败，详见日志';
      const html = url.pathname.startsWith('/settings') ? await render(new URL('http://localhost/settings'), nonce, { text: message, error: true }) : null;
      res.writeHead(status, {'Content-Type':'text/html; charset=utf-8'}).end(html ?? page({ title: '操作未完成', path: url.pathname, nonce, flash: { text: message, error: true }, body: `<p><a href="${url.pathname.startsWith('/skills/') ? '/skills' : '/agents'}">返回</a></p>` }));
    }
  }

  return handlePost;
}

import { $, el, fail, notice, show, showLogin, readToken } from './app';
import { api, readApi } from './api';
import { CloudflareChangeList, CloudflareLink, CloudflareStatus } from '../src/cloudflare/contracts';
import { cs } from './console';
import { selectManagementSubtab } from './management';

let loading = 0;
export async function loadCloudflare() {
  if (!readToken()) return;
  const epoch = cs.epoch, version = ++loading;
  const grant = await readApi(CloudflareStatus, 'GET', '/admin/cloudflare');
  if (epoch !== cs.epoch || version !== loading) return;
  $('cloudflare-login').hidden = !grant.available;
  $('cloudflare-login').textContent = grant.domain ? '重新授权 Cloudflare' : '授权 Cloudflare';
  const scopeLabels: Record<string,string> = { 'cache.purge':'清缓存', 'workers-r2.write':'管理 R2 桶', 'workers-scripts.metadata_read':'查看 Workers' };
  const optional = grant.scopes.filter(scope => scopeLabels[scope]).map(scope => scopeLabels[scope]) ?? [];
  $('cloudflare-state').textContent = grant.reauth ? '授权已失效，请重新授权。' : grant.domain ? '已授权 ' + [grant.domain, ...optional].join(' · ') : '';
  const changes = $('cloudflare-changes'); changes.replaceChildren(); changes.hidden = true;
  if (!grant.domain) return;
  const rows = await readApi(CloudflareChangeList, 'GET', '/admin/cloudflare/changes');
  if (epoch !== cs.epoch || version !== loading) return;
  const status: Record<string,string> = { pending:'等待批准', executing:'已提交执行，请核对实际状态', succeeded:'已执行', rejected:'已拒绝', expired:'已过期', failed:'失败', unknown:'结果待核实' };
  for (const row of rows) {
    const c = row.change;
    const description = c.action === 'dns_create' ? '新增 DNS ' + c.type + ' 记录 ' + c.name + ' → ' + c.content + (c.proxied ? '（启用代理）' : '（仅 DNS）')
      : c.action === 'bucket_create' ? '创建 R2 桶 ' + c.name : '清除以下 URL 的缓存：' + c.urls.join('，');
    const item = el('div', {className:'source'}, [el('strong',{text:description}),
      el('p',{className:'muted small',text:row.domain + ' · 账户 ' + row.account + ' · ' + (status[row.status] ?? row.status)})]);
    if (row.status === 'pending') {
      for (const [decision, text] of [['approve','批准并执行'],['reject','拒绝']] as const) {
        const button = el('button',{type:'button',className:'btn',text});
        button.addEventListener('click',async () => {
          button.disabled = true;
          try { await api('POST', '/admin/cloudflare/changes/' + row.id + '/' + decision); }
          catch (error) { fail(error); } finally { await loadCloudflare().catch(fail); }
        }); item.append(button);
      }
    }
    changes.append(item);
  }
  changes.hidden = rows.length === 0;
}
const callbackPrefix = '#cloudflare?';
const loginKey = 'joule-cloudflare-state';
export function initCloudflare() {
  $('cloudflare-login').addEventListener('click', async () => {
    const button = $('cloudflare-login'); button.disabled = true;
    try {
      const link = await readApi(CloudflareLink, 'POST', '/admin/cloudflare/start');
      const url = new URL(link.url), state = url.searchParams.get('state');
      if (url.origin !== 'https://dash.cloudflare.com' || url.pathname !== '/oauth2/auth' || !state) throw new Error('device_oauth_state');
      try { sessionStorage.setItem(loginKey, state); }
      catch { show('浏览器无法保存授权状态，请允许此站点使用标签页存储后重试。', 'error'); return; }
      location.assign(url.href);
    } catch (error) { fail(error); } finally { button.disabled = false; }
  });
  $('cloudflare-editor').addEventListener('toggle', () => { if ($('cloudflare-editor').open) void loadCloudflare().catch(fail); });
  $('cloudflare-reload').addEventListener('click', () => { void loadCloudflare().catch(fail); });
  if (location.hash.startsWith(callbackPrefix)) {
    cs.view = 'models';
    selectManagementSubtab('models', 'models-mcp');
  }
}

// 在管理台初始化并显示主人会话后处理回调，保留当前标签页的错误提示。
export async function completeCloudflareLogin() {
  if (!location.hash.startsWith(callbackPrefix)) return;
  const query = new URLSearchParams(location.hash.slice(callbackPrefix.length));
  history.replaceState(null, '', location.pathname);
  selectManagementSubtab('models', 'models-mcp');
  $('cloudflare-editor').open = true;
  let expected: string | null = null;
  try {
    expected = sessionStorage.getItem(loginKey);
    sessionStorage.removeItem(loginKey);
  } catch { expected = null; }
  if (!readToken()) { showLogin('授权未完成，请登录后从 Cloudflare 面板重新授权。'); return; }
  const state = query.get('state'), code = query.get('code');
  if (!code || !expected || state !== expected) { show('授权未完成，请从本页重新发起。', 'error'); return; }
  try {
    const grant = await readApi(CloudflareStatus, 'POST', '/admin/cloudflare/complete', { state, code });
    await loadCloudflare();
    notice('Cloudflare 已授权，管理域名为 ' + grant.domain);
  } catch (error) { fail(error); }
}

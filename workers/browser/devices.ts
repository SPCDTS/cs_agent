import { $, el, fail, notice, show, showLogin, readToken } from './app';
import { api, readApi } from './api';
import { CloudflareChangeList, CloudflareLink, CloudflareStatus, DeviceList, DeviceSetup, DeviceView } from '../src/devices/contracts';
import { cs } from './console';
import { selectManagementSubtab } from './management';
import { loadMcpServers } from './mcp-servers';

let draft: { id: string; name: string; desktop: boolean } | undefined;
let loading = 0;
const labels = { provisioning: '正在准备连接，可重试', pairing: '等待设备配对', ready: '已完成配对', revoked: '已撤销' };
export async function loadDevices() {
  if (!readToken()) return;
  const epoch = cs.epoch, version = ++loading;
  const result = await readApi(DeviceList, 'GET', '/admin/devices');
  if (epoch !== cs.epoch || version !== loading) return;
  $('device-create').disabled = !result.configured;
  const grant = result.cloudflare;
  $('device-cloudflare').hidden = !grant?.available;
  $('device-cloudflare').textContent = grant?.domain ? '重新授权 Cloudflare' : '授权 Cloudflare';
  const scopeLabels: Record<string,string> = { 'cache.purge':'清缓存', 'workers-r2.write':'管理 R2 桶', 'workers-scripts.metadata_read':'查看 Workers' };
  const optional = grant?.scopes.filter(scope => scopeLabels[scope]).map(scope => scopeLabels[scope]) ?? [];
  $('device-cloudflare-state').textContent = grant?.reauth ? '授权已失效，请重新授权。' : grant?.domain ? '已授权 ' + [grant.domain, ...optional].join(' · ') : '';
  $('device-state').textContent = result.configured ? '默认启用命令行；桌面选项默认关闭。' : grant?.available ? '授权后，服务端会识别域名并为每台设备创建 Tunnel 和 DNS 记录。' : '部署时登记 Cloudflare OAuth 客户端，或配置设备 Tunnel 凭据。';
  const list = $('device-list'); list.replaceChildren();
  for (const device of result.devices) {
    const revoke = el('button', { type: 'button', className: 'btn', text: device.state === 'revoked' ? '重试关闭入口' : '撤销接入' });
    revoke.addEventListener('click', async () => {
      revoke.disabled = true;
      try { await readApi(DeviceView, 'POST', `/admin/devices/${device.id}/revoke`); await loadDevices(); await loadMcpServers(); }
      catch (error) { fail(error); } finally { revoke.disabled = false; }
    });
    const item = el('div', { className: 'row' }, [
      el('div', { className: 'grow', title: device.serverId }, [
        el('strong', { text: device.name }),
        el('div', { className: 'muted small', text: [labels[device.state], device.desktop ? '命令行 + 桌面' : '命令行', device.id.slice(0, 8)].join(' · ') }),
      ]),
      revoke,
    ]);
    if (['provisioning', 'pairing'].includes(device.state)) {
      const resume = el('button', { type: 'button', className: 'btn', text: '继续配对' });
      resume.addEventListener('click', () => { draft = { id: device.id, name: device.name, desktop: device.desktop }; void prepare(); }); item.append(resume);
    }
    list.append(el('div', { className: 'source' }, [item]));
  }
  const changes = $('device-cf-changes'); changes.replaceChildren(); changes.hidden = true;
  if (!grant?.domain) return;
  const rows = await readApi(CloudflareChangeList, 'GET', '/admin/devices/cloudflare/changes');
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
          try { await api('POST', '/admin/devices/cloudflare/changes/' + row.id + '/' + decision); }
          catch (error) { fail(error); } finally { await loadDevices().catch(fail); }
        }); item.append(button);
      }
    }
    changes.append(item);
  }
  changes.hidden = rows.length === 0;
}
async function prepare() {
  const epoch = cs.epoch;
  $('device-create').disabled = true;
  $('device-state').textContent = '正在准备独立连接…';
  try {
    if (!draft) throw new Error('device_name_required');
    const result = await readApi(DeviceSetup, 'POST', '/admin/devices', draft);
    if (epoch !== cs.epoch) return;
    $('device-link').value = result.pairingUrl; $('device-pairing').hidden = false;
    draft = undefined; await loadDevices();
  } catch (error) { fail(error); $('device-state').textContent = '准备失败。再次点击可重试同一设备；已创建的连接会复用。'; }
  finally { $('device-create').disabled = false; }
}
const callbackPrefix = '#cloudflare?';
const loginKey = 'cs-agent-cloudflare-state';
export function initDevices() {
  $('device-cloudflare').addEventListener('click', async () => {
    const button = $('device-cloudflare'); button.disabled = true;
    try {
      const link = await readApi(CloudflareLink, 'POST', '/admin/devices/cloudflare/start');
      const url = new URL(link.url), state = url.searchParams.get('state');
      if (url.origin !== 'https://dash.cloudflare.com' || url.pathname !== '/oauth2/auth' || !state) throw new Error('device_oauth_state');
      try { sessionStorage.setItem(loginKey, state); }
      catch { show('浏览器无法保存授权状态，请允许此站点使用标签页存储后重试。', 'error'); return; }
      location.assign(url.href);
    } catch (error) { fail(error); } finally { button.disabled = false; }
  });
  $('device-editor').addEventListener('toggle', () => { if ($('device-editor').open) void loadDevices().catch(fail); else { $('device-link').value = ''; $('device-pairing').hidden = true; } });
  $('device-reload').addEventListener('click', () => { void loadDevices().catch(fail); });
  $('device-create').addEventListener('click', () => {
    const name = $('device-name').value.trim(); if (!name) { show('请填写设备名称', 'error'); return; }
    const desktop = $('device-desktop').checked;
    if (!draft || draft.name !== name || draft.desktop !== desktop) draft = { id: crypto.randomUUID(), name, desktop };
    void prepare();
  });
  $('device-copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('device-link').value); notice('已复制，粘贴到设备客户端的提示中。'); } catch (error) { fail(error); } });
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
  $('device-editor').open = true;
  let expected: string | null = null;
  try {
    expected = sessionStorage.getItem(loginKey);
    sessionStorage.removeItem(loginKey);
  } catch { expected = null; }
  if (!readToken()) { showLogin('授权未完成，请登录后从设备面板重新授权。'); return; }
  const state = query.get('state'), code = query.get('code');
  if (!code || !expected || state !== expected) { show('授权未完成，请从本页重新发起。', 'error'); return; }
  try {
    const grant = await readApi(CloudflareStatus, 'POST', '/admin/devices/cloudflare/complete', { state, code });
    await loadDevices();
    notice('Cloudflare 已授权，设备域名为 ' + grant.domain);
  } catch (error) { fail(error); }
}

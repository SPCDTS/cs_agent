import { $, el, fail, show, readToken } from './app';
import { readApi } from './api';
import { DeviceList, DeviceSetup, DeviceView } from '../src/devices/contracts';
import { cs } from './console';
import { loadMcpServers } from './mcp-servers';

let draft: { id: string; name: string; desktop: boolean } | undefined;
let loading = 0;
const labels = { provisioning: '正在准备连接，可重试', pairing: '等待设备配对', ready: '已接入（不表示设备当前在线）', revoked: '已撤销' };
export async function loadDevices() {
  if (!readToken()) return;
  const epoch = cs.epoch, version = ++loading;
  const result = await readApi(DeviceList, 'GET', '/admin/devices');
  if (epoch !== cs.epoch || version !== loading) return;
  $('device-create').disabled = !result.configured;
  $('device-state').textContent = result.configured ? '默认启用命令行；桌面选项默认关闭。' : '实例尚未配置设备 Tunnel。管理员需设置 DEVICE_TUNNEL_ACCOUNT_ID、ZONE_ID、DOMAIN 和 API_TOKEN；设备使用者无需配置这些参数。';
  const list = $('device-list'); list.replaceChildren();
  for (const device of result.devices) {
    const revoke = el('button', { type: 'button', className: 'btn', text: device.state === 'revoked' ? '重试关闭入口' : '撤销接入' });
    revoke.addEventListener('click', async () => {
      revoke.disabled = true;
      try { await readApi(DeviceView, 'POST', `/admin/devices/${device.id}/revoke`); await loadDevices(); await loadMcpServers(); }
      catch (error) { fail(error); } finally { revoke.disabled = false; }
    });
    const item = el('div', { className: 'source' }, [el('strong', { text: device.name }), el('p', { className: 'muted small', text: labels[device.state] + (device.desktop ? ' · 命令行 + 桌面' : ' · 命令行') }), revoke]);
    if (['provisioning', 'pairing'].includes(device.state)) {
      const resume = el('button', { type: 'button', className: 'btn', text: '继续配对' });
      resume.addEventListener('click', () => { draft = { id: device.id, name: device.name, desktop: device.desktop }; void prepare(); }); item.append(resume);
    }
    list.append(item);
  }
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
export function initDevices() {
  $('device-editor').addEventListener('toggle', () => { if ($('device-editor').open) void loadDevices().catch(fail); else { $('device-link').value = ''; $('device-pairing').hidden = true; } });
  $('device-reload').addEventListener('click', () => { void loadDevices().catch(fail); });
  $('device-create').addEventListener('click', () => {
    const name = $('device-name').value.trim(); if (!name) { show('请填写设备名称', 'error'); return; }
    const desktop = $('device-desktop').checked;
    if (!draft || draft.name !== name || draft.desktop !== desktop) draft = { id: crypto.randomUUID(), name, desktop };
    void prepare();
  });
  $('device-copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('device-link').value); show('已复制，粘贴到设备客户端的提示中。', 'success'); } catch (error) { fail(error); } });
}

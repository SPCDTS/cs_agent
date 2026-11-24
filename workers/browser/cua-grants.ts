import { Check } from 'typebox/value';
import { CuaDeviceId, CuaDirectory, CuaGrantList } from '../src/cua/contracts';
import { ApiError, readApi } from './api';
import { $, el, fail, readToken, show } from './app';
import { cs } from './console';

let directory: CuaDirectory | undefined;
let sequence = 0;
let saving = false;

function renderDevices() {
  const scope = $('cua-grant-scope').value;
  const selected = directory?.grants.find(row => row.scope === scope)?.spaces ?? [];
  const records = (directory?.devices ?? []).filter(row => Check(CuaDeviceId,row.id));
  const missing = selected.filter(id => !records.some(row => row.id === id));
  const rows = records.map(row => ({id:row.id, name:row.name, detail:[row.os,row.status,row.id].filter(Boolean).join(' · ')}));
  for (const id of missing) rows.push({id,name:id,detail:'目录中暂不可用，可撤销分配'});
  const list = $('cua-grant-devices');
  list.replaceChildren(...rows.map(row => {
    const checkbox = el('input',{type:'checkbox',value:row.id});
    checkbox.checked = selected.includes(row.id);
    checkbox.disabled = !scope || saving;
    return el('label',{className:'source row'},[checkbox,el('span',{},[
      el('strong',{text:row.name}),el('small',{className:'muted',text:'　'+row.detail}),
    ])]);
  }));
  $('cua-grant-save').disabled = !directory || !scope || saving || !rows.length;
}

export async function loadCuaGrants() {
  const version = ++sequence, epoch = cs.epoch;
  const select = $('cua-grant-scope'), prior = select.value;
  directory = undefined;
  renderDevices();
  select.replaceChildren();
  if (!readToken()) return;
  $('cua-grant-status').textContent = '正在读取设备目录和会话分配…';
  try {
    const data = await readApi(CuaDirectory,'GET','/admin/cua/devices');
    if (version !== sequence || epoch !== cs.epoch) return;
    directory = data;
    const choices = new Map(data.threads.map(t => [t.key,t.name ? t.name+' · '+t.key : t.key]));
    for (const row of data.grants) if (!choices.has(row.scope)) choices.set(row.scope,row.scope);
    select.replaceChildren(el('option',{value:'',text:'选择群聊或私聊'}),...[...choices].map(([value,text]) => el('option',{value,text})));
    if (choices.has(prior)) select.value = prior;
    $('cua-grant-status').textContent = !data.configured ? '尚未配置 Cua 反向 MCP 服务。' : !data.enabled ? 'Cua 服务已停用。'
      : !data.online ? 'Cua 节点离线，可撤销已有分配。' : data.error ? '设备目录读取失败，可撤销已有分配。'
      : !data.available ? '请在 Cua 服务中启用 list_spaces 目录。'
      : !data.devices.length ? '控制节点尚未列出设备。' : '';
    renderDevices();
  } catch (error) {
    if (version === sequence && epoch === cs.epoch) {
      $('cua-grant-status').textContent = '读取失败，请刷新设备与分配。';
      fail(error);
    }
  }
}

async function save() {
  if (saving || !directory) return;
  const select = $('cua-grant-scope'), scope = select.value;
  if (!scope) return;
  const spaces = [...$('cua-grant-devices').querySelectorAll<HTMLInputElement>('input:checked')].map(input => input.value);
  saving = true;
  for (const input of $('cua-grant-devices').querySelectorAll('input')) input.disabled = true;
  select.disabled = $('cua-grant-reload').disabled = $('cua-grant-save').disabled = true;
  try {
    await readApi(CuaGrantList,'PUT','/admin/cua/grants',{scope,spaces,expectedRevision:directory.revision});
    show('设备分配已保存。','info');
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) show('设备分配已变更，请核对最新目录后重新选择。','error');
    else fail(error);
  } finally {
    saving = false;
    select.disabled = $('cua-grant-reload').disabled = false;
    await loadCuaGrants();
  }
}

export function initCuaGrants() {
  $('cua-grant-scope').addEventListener('change',renderDevices);
  $('cua-grant-reload').addEventListener('click',() => void loadCuaGrants());
  $('cua-grant-save').addEventListener('click',() => void save());
}

import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { CuaBridgeToken, CuaDeviceId, CuaDirectory, CuaGrantList, CuaNameResult } from '../src/cua/contracts';
import { api, ApiError, readApi } from './api';
import { $, el, fail, readToken, show } from './app';
import { consoleView, cs } from './console';

let directory: CuaDirectory | undefined;
let sequence = 0;
let saving = false;
let enabling = false;
let setupTimer: ReturnType<typeof setTimeout> | undefined;

type Device = CuaDirectory['devices'][number];
const updating = new Map<Device,{epoch:number, token:string, done:Promise<void>}>();
function pendingNameWrites() {
  const token = readToken(), epoch = cs.epoch;
  return [...updating.values()].filter(write => write.epoch === epoch && write.token === token);
}
function updateActions() {
  const busy = saving || pendingNameWrites().length > 0;
  $('cua-grant-reload').disabled = busy;
  $('cua-grant-save').disabled = busy || !directory || !$('cua-grant-scope').value || !$('cua-grant-devices').childElementCount;
}

const nameViews = new Map<Device, () => void>();

function addNameEditor(row: Device, title: HTMLElement, view: CuaDirectory) {
  const controls = el('div',{className:'row'});
  const button = (text: string, onclick: () => void) => el('button',{type:'button',className:'btn',text,onclick});
  function close() {
    title.textContent = row.name;
    const edit = button('改名',open);
    edit.setAttribute('aria-label','更改设备名称 '+row.name);
    edit.disabled = updating.has(row);
    controls.replaceChildren(edit);
  }
  function open() {
    const expectedName = row.alias ?? '', defaultName = row.defaultName || row.name;
    const input = el('input',{type:'text',value:expectedName,placeholder:'默认名称 · '+defaultName,'aria-label':'设备显示名，最多 64 个字符'});
    const submit = button('保存名称',() => void saveName()), cancel = button('取消',close);
    const restore = button('恢复默认名称',() => { input.value = ''; input.focus(); });
    controls.replaceChildren(input,submit,cancel,...(expectedName ? [restore] : []));
    input.focus();
    input.addEventListener('keydown',event => {
      if (event.isComposing || updating.has(row)) return;
      if (event.key === 'Enter') { event.preventDefault(); void saveName(); }
      if (event.key === 'Escape') { event.preventDefault(); close(); }
    });
    async function saveName() {
      if (saving || updating.has(row) || directory !== view) return;
      const name = input.value.trim();
      if ([...name].length > 64) { show('设备名称最多 64 个字符。','error'); return; }
      if (name === expectedName) { close(); return; }
      const epoch = cs.epoch, token = readToken();
      if (!token) return;
      const finished = Promise.withResolvers<void>();
      updating.set(row,{epoch,token,done:finished.promise});
      updateActions();
      for (const control of [input,submit,cancel,restore]) control.disabled = true;
      const isCurrent = () => directory === view && cs.epoch === epoch && readToken() === token;
      let saved = false;
      try {
        const result = await readApi(CuaNameResult,'PUT','/admin/cua/name',{space:row.id,name,expectedName,expectedRevision:view.revision},isCurrent);
        row.alias = result.name || undefined;
        row.name = result.name || defaultName;
        show(result.name ? '设备名称已保存。' : '已恢复默认设备名称。','info');
        saved = true;
      } catch (error) {
        if (isCurrent()) {
          if (error instanceof ApiError && error.status === 409) show('设备名称或目录已更新，请刷新后再试。','error');
          else fail(error);
        }
      } finally {
        updating.delete(row);
        finished.resolve();
        if (isCurrent()) updateActions();
        for (const control of [input,submit,cancel,restore]) control.disabled = false;
        // 切换会话会创建新的行。只更新这台设备的名称，不触碰其他行和当前勾选。
        if (isCurrent() && (saved || !controls.isConnected)) nameViews.get(row)?.();
      }
    }
  }
  nameViews.set(row,close);
  close();
  return controls;
}

function renderDevices() {
  const view = directory, scope = $('cua-grant-scope').value;
  const selected = view?.grants.find(row => row.scope === scope)?.spaces ?? [];
  const records = view?.devices ?? [];
  const missing = selected.filter(id => !records.some(row => row.id === id));
  nameViews.clear();
  function deviceLine(id: string, title: HTMLElement, detail: string) {
    const checkbox = el('input',{type:'checkbox',value:id});
    checkbox.checked = selected.includes(id);
    checkbox.disabled = !scope || saving;
    return el('label',{className:'row'},[checkbox,title,el('small',{className:'muted',text:detail})]);
  }
  const rows = records.map(row => {
    const title = el('strong',{text:row.name}), line = deviceLine(row.id,title,[row.os,row.status,row.id].filter(Boolean).join(' · '));
    return el('div',{className:'source','data-space':row.id},[line,view?.online && view.available ? addNameEditor(row,title,view) : null]);
  });
  for (const id of missing) rows.push(el('div',{className:'source'},[deviceLine(id,el('strong',{text:id}),'目录中暂不可用，可撤销分配')]));
  $('cua-grant-devices').replaceChildren(...rows);
  updateActions();
}

export async function loadCuaGrants() {
  clearTimeout(setupTimer);
  const wasPending = directory?.setup === 'pending';
  const version = ++sequence, epoch = cs.epoch, token = readToken();
  const isCurrent = () => version === sequence && epoch === cs.epoch && readToken() === token;
  // 标签页切换也会触发刷新。等待本次登录的名称写入落地，再读取同一目录。
  let waited = false;
  while (token && isCurrent()) {
    const writes = pendingNameWrites();
    if (!writes.length) break;
    waited = true;
    await Promise.all(writes.map(write => write.done));
  }
  function scheduleSetupRefresh() {
    setupTimer = setTimeout(() => {
      if (isCurrent() && !$('cua-grants-section').closest('[hidden]')) void loadCuaGrants();
    }, 5000);
  }
  if (!isCurrent()) return;
  const select = $('cua-grant-scope'), prior = select.value;
  const draft = new Map<string,boolean>();
  if (waited && directory && prior) {
    const persisted = directory.grants.find(grant => grant.scope === prior)?.spaces ?? [];
    for (const input of $('cua-grant-devices').querySelectorAll<HTMLInputElement>('input[type=checkbox]')) {
      if (input.checked !== persisted.includes(input.value)) draft.set(input.value,input.checked);
    }
  }
  directory = undefined;
  renderDevices();
  select.replaceChildren();
  $('cua-pair-form').hidden = true;
  $('cua-setup-form').hidden = true;
  $('cua-bridge-url').hidden = true;
  if (!token) return;
  $('cua-grant-status').textContent = '正在读取设备目录和会话分配…';
  try {
    const data = await readApi(CuaDirectory,'GET','/admin/cua/devices',undefined,isCurrent);
    const devices = data.devices.filter(row => Check(CuaDeviceId,row.id));
    for (const row of devices) row.defaultName ??= row.name;
    directory = {...data,devices};
    const choices = new Map(data.threads.map(t => [t.key,t.name ? t.name+' · '+t.key : t.key]));
    for (const row of data.grants) if (!choices.has(row.scope)) choices.set(row.scope,row.scope);
    select.replaceChildren(el('option',{value:'',text:'选择群聊或私聊'}),...[...choices].map(([value,text]) => el('option',{value,text})));
    if (choices.has(prior)) select.value = prior;
    $('cua-pair-form').hidden = !(data.enabled && data.online);
    if ($('cua-pair-form').hidden) clearPairing();
    $('cua-setup-form').hidden = data.setup !== 'new';
    const bridgeUrl = $('cua-bridge-url');
    bridgeUrl.hidden = !data.bridgeUrl;
    bridgeUrl.textContent = data.bridgeUrl ? 'VPS 桥连接地址：' + data.bridgeUrl : '';
    if ($('cua-setup-form').hidden) $('cua-setup-token').value = '';
    if (data.setup === 'pending') scheduleSetupRefresh();
    $('cua-grant-status').textContent = data.setup === 'pending'
      ? (data.online ? 'VPS 已连接，正在检测工具。若持续未启用，请核对 VPS 桥版本。' : 'cs-agent 已保存配置，等待 VPS 连接。')
      : !data.configured ? '尚未配置 Cua 反向 MCP 服务。' : !data.enabled ? 'Cua 服务已停用。'
      : !data.online ? 'Cua 节点离线，可撤销已有分配。' : data.error ? '设备目录读取失败，可撤销已有分配。'
      : !data.available ? '请在 Cua 服务中启用 list_spaces 目录。'
      : !data.devices.length ? '控制节点尚未列出设备。'
      : !devices.length ? '当前目录的设备 ID 暂不支持分配。' : '';
    renderDevices();
    if (select.value === prior && draft.size) {
      for (const input of $('cua-grant-devices').querySelectorAll<HTMLInputElement>('input[type=checkbox]')) {
        if (draft.has(input.value)) input.checked = draft.get(input.value)!;
      }
    }
  } catch (error) {
    if (isCurrent()) {
      if (wasPending || (error instanceof ApiError && error.status === 409)) scheduleSetupRefresh();
      $('cua-grant-status').textContent = '读取失败，请刷新设备与分配。';
      fail(error);
    }
  }
}

async function save() {
  if (saving || !directory || pendingNameWrites().length) return;
  const select = $('cua-grant-scope'), scope = select.value;
  if (!scope) return;
  const spaces = [...$('cua-grant-devices').querySelectorAll<HTMLInputElement>('input[type=checkbox]:checked')].map(input => input.value);
  saving = true;
  for (const input of $('cua-grant-devices').querySelectorAll<HTMLInputElement>('input[type=checkbox]')) input.disabled = true;
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

async function enableCua(event: SubmitEvent) {
  event.preventDefault();
  const epoch = cs.epoch, admin = readToken();
  if (!admin || enabling || directory?.setup !== 'new') return;
  const input = $('cua-setup-token'), token = input.value.trim();
  if (!Check(CuaBridgeToken,token)) {
    show('桥令牌需为 32 至 256 位，可用字母、数字及 . _ ~ -。','error');
    input.focus();
    return;
  }
  const isCurrent = () => cs.epoch === epoch && readToken() === admin;
  input.value = '';
  enabling = true;
  $('cua-setup-enable').disabled = true;
  try {
    await api('PUT','/admin/cua/setup',{token},isCurrent);
  } catch (error) {
    if (isCurrent()) {
      if (error instanceof ApiError && error.status === 409) show('Cua 已有其他配置，请在 MCP 服务中核对。','error');
      else fail(error);
    }
  } finally {
    enabling = false;
    $('cua-setup-enable').disabled = false;
    if (isCurrent()) await loadCuaGrants();
  }
}

const PairTicket = Type.Object({ticket:Type.String({pattern:'^[0-9a-f.-]{160,220}$'}),
  expires:Type.Integer(),origin:Type.String({pattern:'^https://[a-zA-Z0-9.-]+(:[0-9]+)?$'})});
let pairingTimer: ReturnType<typeof setTimeout> | undefined;
function clearPairing() {
  clearTimeout(pairingTimer);
  $('cua-pair-command').value = '';
  $('cua-pair-result').hidden = true;
}
async function issueDevice() {
  const button = $('cua-pair-issue'), epoch = cs.epoch, token = readToken();
  if (!token || button.disabled || !directory?.online || !directory.enabled) return;
  const isCurrent = () => cs.epoch === epoch && readToken() === token;
  const windows = $('cua-pair-platform').value === 'windows';
  clearPairing();
  button.disabled = $('cua-pair-platform').disabled = true;
  try {
    const {ticket,expires,origin} = await readApi(PairTicket,'POST','/admin/cua/pair',undefined,isCurrent);
    if (!isCurrent() || !directory?.online || !directory.enabled || expires <= Date.now()) return;
    const command = windows
      ? `$p = Join-Path $env:TEMP ([guid]::NewGuid().ToString() + '.ps1'); try { Invoke-WebRequest -ErrorAction Stop -UseBasicParsing '${origin}/cua/join/windows.ps1' -OutFile $p; & $p '${origin}' '${ticket}' } finally { Remove-Item -LiteralPath $p -ErrorAction SilentlyContinue }`
      : `(p=$(mktemp) || exit 1; trap 'rm -f "$p"' EXIT; curl -fsS '${origin}/cua/join/mac.sh' -o "$p" && /bin/bash "$p" '${origin}' '${ticket}')`;
    $('cua-pair-command').value = command;
    $('cua-pair-label').textContent = '在目标设备的'+(windows ? ' PowerShell' : '终端')+'运行，有效至 '+new Date(expires).toLocaleTimeString()+'。请私下传递。';
    $('cua-pair-result').hidden = false;
    pairingTimer = setTimeout(clearPairing,expires-Date.now());
  } catch (error) {
    if (!isCurrent()) return;
    if (error instanceof ApiError && error.body?.error === 'pairing_full') show('VPS 的设备名额已用完。','error');
    else if (error instanceof ApiError && error.status === 503) show('VPS 配对服务不可用，请核对桥版本和设备接入配置。','error');
    else fail(error);
  } finally {
    button.disabled = $('cua-pair-platform').disabled = false;
  }
}

export function initCuaGrants() {
  $('cua-pair-issue').addEventListener('click',() => void issueDevice());
  $('cua-pair-platform').addEventListener('change',clearPairing);
  $('cua-pair-copy').addEventListener('click',async () => {
    const input = $('cua-pair-command');
    try { await navigator.clipboard.writeText(input.value); show('接入命令已复制。','info'); }
    catch { input.focus(); input.select(); show('已选中接入命令，请复制。','info'); }
  });
  $('open-cua-settings').addEventListener('click',() => consoleView('access','access-cua-tab'));
  $('cua-setup-form').addEventListener('submit',enableCua);
  $('cua-grant-scope').addEventListener('change',renderDevices);
  $('cua-grant-reload').addEventListener('click',() => void loadCuaGrants());
  $('cua-grant-save').addEventListener('click',() => void save());
}

import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { CuaBridgeToken, CuaDeviceId, CuaDirectory, CuaGrantList, CuaNameResult } from '../src/cua/contracts';
import { api, ApiError, readApi } from './api';
import { $, el, fail, pill, readToken, show } from './app';
import { consoleView, cs } from './console';

type Device = CuaDirectory['devices'][number] & { missing?: boolean };
type ScopeChoice = { key: string; name?: string; type: 'group' | 'private' };
type Platform = 'mac' | 'windows';
type CardFilter = 'all' | 'online' | 'offline' | 'pending';
type SessionFilter = 'all' | 'group' | 'private';

type PendingCard = {
  id: string;
  platform: Platform;
  ticket: string;
  expires: number;
  origin: string;
  baselineIds: Set<string>;
  preScopes: string[];
  sessionFilter: SessionFilter;
  expired: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

const PairTicket = Type.Object({
  ticket: Type.String({ pattern: '^[0-9a-f.-]{160,220}$' }),
  expires: Type.Integer(),
  origin: Type.String({ pattern: '^https://[a-zA-Z0-9.-]+(:[0-9]+)?$' }),
});

const TOOL_LABELS: Record<string, string> = {
  list_spaces: '设备目录',
  list_tools: 'Driver 目录',
  space_bash: 'Shell 命令',
  space_job: '后台任务',
  space_write: '写文件',
  call_tool: '桌面操作',
};

let directory: CuaDirectory | undefined;
let sequence = 0;
let enabling = false;
let issuingPair = false;
let pendingSequence = 0;
let setupTimer: ReturnType<typeof setTimeout> | undefined;
let activeFilter: CardFilter = 'all';
let searchQuery = '';
let boundDoc: Document | undefined;

const pendingCards: PendingCard[] = [];
const draftsBySpace = new Map<string, Set<string>>();
const sessionFilterBySpace = new Map<string, SessionFilter>();
const renamingSpaces = new Set<string>();
const renameDrafts = new Map<string, string>();
const savingSpaces = new Set<string>();
const updating = new Map<string, { epoch: number; token: string; done: Promise<void> }>();

function pendingNameWrites() {
  const token = readToken(), epoch = cs.epoch;
  return [...updating.values()].filter(write => write.epoch === epoch && write.token === token);
}

function anyBusy() {
  return savingSpaces.size > 0 || pendingNameWrites().length > 0;
}

function buildJoinCommand(platform: Platform, origin: string, ticket: string) {
  return platform === 'windows'
    ? `$p = Join-Path $env:TEMP ([guid]::NewGuid().ToString() + '.ps1'); try { Invoke-WebRequest -ErrorAction Stop -UseBasicParsing '${origin}/cua/join/windows.ps1' -OutFile $p; & $p '${origin}' '${ticket}' } finally { Remove-Item -LiteralPath $p -ErrorAction SilentlyContinue }`
    : `(p=$(mktemp) || exit 1; trap 'rm -f "$p"' EXIT; curl -fsS '${origin}/cua/join/mac.sh' -o "$p" && /bin/bash "$p" '${origin}' '${ticket}')`;
}

function clearPendingCards() {
  for (const card of pendingCards) clearTimeout(card.timer);
  pendingCards.length = 0;
}

function clearAllCuaState() {
  clearTimeout(setupTimer);
  clearPendingCards();
  directory = undefined;
  draftsBySpace.clear();
  sessionFilterBySpace.clear();
  renamingSpaces.clear();
  renameDrafts.clear();
  savingSpaces.clear();
  activeFilter = 'all';
  searchQuery = '';
  $('cua-setup-token').value = '';
  $('cua-search').value = '';
  renderAll();
}

function scopeChoices(view: CuaDirectory | undefined): ScopeChoice[] {
  if (!view) return [];
  const choices = new Map<string, ScopeChoice>();
  for (const t of view.threads) {
    if (choices.has(t.key)) continue;
    choices.set(t.key, { key: t.key, name: t.name, type: t.key.startsWith('private:') ? 'private' : 'group' });
  }
  for (const grant of view.grants) {
    if (choices.has(grant.scope)) continue;
    choices.set(grant.scope, { key: grant.scope, type: grant.scope.startsWith('private:') ? 'private' : 'group' });
  }
  return [...choices.values()];
}

function mergedDevices(view: CuaDirectory | undefined): { valid: Device[]; all: Device[]; hasUnsupported: boolean } {
  if (!view) return { valid: [], all: [], hasUnsupported: false };
  const valid: Device[] = [];
  for (const row of view.devices) {
    if (!Check(CuaDeviceId, row.id)) continue;
    valid.push({ ...row, defaultName: row.defaultName ?? row.name, missing: false });
  }
  const hasUnsupported = view.devices.length > 0 && valid.length === 0;
  const known = new Set(valid.map(row => row.id));
  const missingScopes = new Map<string, string[]>();
  for (const grant of view.grants) {
    for (const spaceId of grant.spaces) {
      if (known.has(spaceId)) continue;
      const list = missingScopes.get(spaceId);
      if (list) list.push(grant.scope);
      else missingScopes.set(spaceId, [grant.scope]);
    }
  }
  const missing: Device[] = [...missingScopes].map(([id, scopes]) => ({
    id,
    name: id,
    defaultName: id,
    os: '',
    status: 'offline',
    scopes,
    missing: true,
  }));
  return { valid, all: [...valid, ...missing], hasUnsupported };
}

function canGrantNew(view: CuaDirectory | undefined, card: Device): boolean {
  return Boolean(view?.enabled && view.online && view.available && !card.missing);
}

function deviceOnlineForFilter(view: CuaDirectory | undefined, card: Device): boolean {
  return Boolean(view?.enabled && view.online && view.available && !card.missing && card.status !== 'offline' && card.status !== 'disconnected');
}

function deviceStatusPill(view: CuaDirectory | undefined, card: Device): HTMLElement {
  if (!view?.configured) return pill('未配置', 'neutral');
  if (!view.enabled) return pill('服务停用', 'warn');
  if (!view.online) return pill('Relay 离线', 'bad');
  if (card.missing) return pill('目录暂不可用', 'neutral');
  if (card.status === 'offline' || card.status === 'disconnected') return pill('设备离线', 'warn');
  return pill(card.status ? `在线 · ${card.status}` : '在线', 'ok');
}

function relayBadge(view: CuaDirectory | undefined): { text: string; tone: string } {
  if (!view) return { text: '未加载设备目录', tone: 'neutral' };
  if (view.setup === 'new') return { text: '未配置 VPS Relay', tone: 'neutral' };
  if (view.setup === 'pending') {
    return view.online
      ? { text: 'VPS Relay 已连接（检测工具中）', tone: 'warn' }
      : { text: '等待 VPS Relay 连接', tone: 'warn' };
  }
  if (!view.configured) return { text: '未配置 Cua 服务', tone: 'neutral' };
  if (!view.enabled) return { text: 'Cua 服务已停用', tone: 'warn' };
  if (!view.online) return { text: 'VPS Relay 未连接（离线）', tone: 'bad' };
  if (view.error) return { text: 'VPS Relay 已连接（目录异常）', tone: 'warn' };
  if (!view.available) return { text: 'VPS Relay 已连接（未启用目录）', tone: 'warn' };
  return { text: 'VPS Relay 已连接', tone: 'ok' };
}

function updateRelaySummary(view: CuaDirectory | undefined, devices: { valid: Device[]; all: Device[] }, scopes: ScopeChoice[]) {
  const badge = relayBadge(view);
  const relayPill = $('cua-relay-pill');
  relayPill.className = `pill ${badge.tone}`;
  relayPill.textContent = badge.text;

  const bridgeUrl = $('cua-bridge-url');
  const bridgeCopy = $('cua-bridge-copy');
  bridgeUrl.hidden = !view?.bridgeUrl;
  bridgeUrl.textContent = view?.bridgeUrl ? `VPS 桥接地址：${view.bridgeUrl}` : '';
  bridgeCopy.hidden = !view?.bridgeUrl;

  const toolsEl = $('cua-relay-tools');
  const tools = view?.tools ?? [];
  if (tools.length) {
    toolsEl.replaceChildren(
      el('span', { className: 'muted small', text: '已启用能力：' }),
      ...tools.map(name => pill(TOOL_LABELS[name] ?? name, 'neutral')),
    );
    toolsEl.hidden = false;
  } else {
    toolsEl.replaceChildren();
    toolsEl.hidden = true;
  }

  const onlineCount = devices.valid.filter(d => deviceOnlineForFilter(view, d)).length;
  const grantCount = view?.grants.reduce((sum, g) => sum + g.spaces.length, 0) ?? 0;
  $('cua-stat-online').textContent = `${onlineCount} / ${devices.valid.length}`;
  $('cua-stat-pending').textContent = String(pendingCards.length);
  $('cua-stat-grants').textContent = String(grantCount);
  $('cua-stat-threads').textContent = String(scopes.length);
}

function renderFilterBar(view: CuaDirectory | undefined, devices: Device[]) {
  const onlineCount = devices.filter(d => deviceOnlineForFilter(view, d)).length;
  const offlineCount = devices.length - onlineCount;
  const tabs: { id: CardFilter; label: string; count: number }[] = [
    { id: 'all', label: '全部', count: devices.length + pendingCards.length },
    { id: 'online', label: '在线', count: onlineCount },
    { id: 'offline', label: '离线', count: offlineCount },
    { id: 'pending', label: '待接入', count: pendingCards.length },
  ];
  $('cua-filter-tabs').replaceChildren(
    ...tabs.map(tab => el('button', {
      type: 'button',
      className: `chip${activeFilter === tab.id ? ' on' : ''}`,
      text: `${tab.label} ${tab.count}`,
      onclick: () => {
        activeFilter = tab.id;
        renderAll();
      },
    })),
  );
}

function updateTopActions() {
  const busy = anyBusy();
  $('cua-grant-reload').disabled = busy;
  $('cua-pair-add').disabled = busy || issuingPair || !directory?.enabled || !directory.online;
}

function createSessionChecklist(options: {
  scopes: ScopeChoice[];
  selected: Set<string>;
  saved: Set<string>;
  filter: SessionFilter;
  allowNew: boolean;
  busy: boolean;
  isPending: boolean;
  onFilterChange: (next: SessionFilter) => void;
  onToggle: (scopeKey: string, checked: boolean) => void;
  onSelectAll: (visibleKeys: string[]) => void;
  onClearVisible: (visibleKeys: string[]) => void;
}) {
  const { scopes, selected, saved, filter, allowNew, busy, isPending, onFilterChange, onToggle, onSelectAll, onClearVisible } = options;
  const visible = scopes.filter(s => filter === 'all' || s.type === filter);
  const visibleKeys = visible.map(s => s.key);
  const canSelectAll = !busy && (isPending || allowNew) && visibleKeys.length > 0;
  const canClear = !busy && visibleKeys.some(k => selected.has(k));

  const head = el('div', { className: 'cua-sessions-head' }, [
    el('div', { className: 'row' }, [
      el('strong', { text: isPending ? '预选授权会话' : '已授权会话' }),
      el('span', { className: 'muted small mono', text: `${selected.size} / ${scopes.length}` }),
    ]),
    el('div', { className: 'row' }, [
      ...(['all', 'group', 'private'] as const).map(f => el('button', {
        type: 'button',
        className: 'btn compact',
        'aria-pressed': filter === f ? 'true' : 'false',
        text: f === 'all' ? '全部' : f === 'group' ? '群聊' : '私聊',
        onclick: () => onFilterChange(f),
      })),
      el('button', { type: 'button', className: 'btn compact', text: '全选', disabled: !canSelectAll, onclick: () => onSelectAll(visibleKeys) }),
      el('button', { type: 'button', className: 'btn compact', text: '清空', disabled: !canClear, onclick: () => onClearVisible(visibleKeys) }),
    ]),
  ]);

  const listChildren: HTMLElement[] = [];
  if (!isPending && !allowNew) {
    listChildren.push(el('p', { className: 'muted small', style: 'margin:0', text: '当前不可新增授权，仅可取消勾选已有会话并保存撤销。' }));
  }
  if (!visible.length) {
    listChildren.push(el('div', { className: 'muted small', text: scopes.length ? '当前筛选下没有会话。' : '暂无可分配的群聊或私聊。' }));
  } else {
    for (const s of visible) {
      const checked = selected.has(s.key);
      const wasSaved = saved.has(s.key);
      const lockedNew = !isPending && !allowNew && !wasSaved;

      const checkbox = el('input', {
        type: 'checkbox',
        value: s.key,
        disabled: busy || lockedNew,
      }) as HTMLInputElement;
      checkbox.checked = checked;
      checkbox.addEventListener('change', () => onToggle(s.key, checkbox.checked));

      let stateNode: HTMLElement | null = null;
      if (isPending) {
        stateNode = checked ? pill('上线后生效', 'ok') : pill('未预选', 'neutral');
      } else if (wasSaved && checked) {
        stateNode = pill('已保存', 'ok');
      } else if (!wasSaved && checked) {
        stateNode = pill('待新增', 'warn');
      } else if (wasSaved && !checked) {
        stateNode = pill('待撤销', 'bad');
      }

      const labelText = s.name ? `${s.name}` : s.key;
      const row = el('label', {
        className: `cua-session-row${checked ? ' is-checked' : ''}${lockedNew ? ' is-disabled' : ''}`,
        title: lockedNew ? '离线或目录不可用时不可新增授权，仅可撤销已有授权' : '',
      }, [
        el('div', { className: 'cua-session-main' }, [
          checkbox,
          pill(s.type === 'group' ? '群聊' : '私聊', 'neutral'),
          el('div', { className: 'cua-session-text' }, [
            el('span', { text: labelText }),
            el('small', { className: 'muted mono', text: s.key }),
          ]),
        ]),
        el('div', { className: 'row' }, [
          lockedNew ? el('small', { className: 'muted', text: '离线锁定' }) : null,
          stateNode,
        ]),
      ]);
      listChildren.push(row);
    }
  }

  return el('div', { className: 'stack flat-stack' }, [
    head,
    el('div', { className: 'cua-session-list' }, listChildren),
  ]);
}

function renderPendingCardNode(card: PendingCard, scopes: ScopeChoice[]): HTMLElement {
  const command = card.expired ? '' : buildJoinCommand(card.platform, card.origin, card.ticket);
  const expiresLabel = card.expired
    ? '一次性命令已过期，请点击「重新生成命令」。'
    : `在目标设备的${card.platform === 'windows' ? ' PowerShell' : '终端'}运行，有效至 ${new Date(card.expires).toLocaleTimeString()}。请私下传递。`;

  const platformSelect = el('select', {
    'aria-label': '新设备系统',
    onchange: () => {
      card.platform = platformSelect.value === 'windows' ? 'windows' : 'mac';
      renderAll();
    },
  }, [
    el('option', { value: 'mac', text: 'macOS' }),
    el('option', { value: 'windows', text: 'Windows x64' }),
  ]) as HTMLSelectElement;
  platformSelect.value = card.platform;

  const cmdArea = el('textarea', {
    className: 'cua-cmd-area',
    readonly: true,
    rows: 4,
    spellcheck: false,
    'aria-label': '设备接入命令',
  }) as HTMLTextAreaElement;
  cmdArea.value = command;

  const copyBtn = el('button', {
    type: 'button',
    className: 'btn',
    text: '复制命令',
    disabled: card.expired || !command,
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(cmdArea.value);
        show('接入命令已复制。', 'info');
      } catch {
        cmdArea.focus();
        cmdArea.select();
        show('已选中接入命令，请复制。', 'info');
      }
    },
  });

  const reissueBtn = el('button', {
    type: 'button',
    className: 'btn',
    text: '重新生成命令',
    disabled: issuingPair || !directory?.enabled || !directory.online,
    onclick: () => void issuePendingCard(card),
  });

  const refreshCheckBtn = el('button', {
    type: 'button',
    className: 'btn primary',
    text: '刷新检测上线',
    disabled: anyBusy(),
    onclick: () => void loadCuaGrants(),
  });

  const removeBtn = el('button', {
    type: 'button',
    className: 'btn danger',
    text: '取消并移除',
    onclick: () => {
      clearTimeout(card.timer);
      const idx = pendingCards.indexOf(card);
      if (idx >= 0) pendingCards.splice(idx, 1);
      renderAll();
    },
  });

  const checklist = createSessionChecklist({
    scopes,
    selected: new Set(card.preScopes),
    saved: new Set<string>(),
    filter: card.sessionFilter,
    allowNew: true,
    busy: false,
    isPending: true,
    onFilterChange: next => {
      card.sessionFilter = next;
      renderAll();
    },
    onToggle: (scopeKey, checked) => {
      if (checked && !card.preScopes.includes(scopeKey)) card.preScopes.push(scopeKey);
      if (!checked) card.preScopes = card.preScopes.filter(k => k !== scopeKey);
      renderAll();
    },
    onSelectAll: visibleKeys => {
      card.preScopes = [...new Set([...card.preScopes, ...visibleKeys])];
      renderAll();
    },
    onClearVisible: visibleKeys => {
      const drop = new Set(visibleKeys);
      card.preScopes = card.preScopes.filter(k => !drop.has(k));
      renderAll();
    },
  });

  return el('article', { className: 'cua-card is-pending', 'data-pending-card': card.id }, [
    el('div', { className: 'cua-card-head' }, [
      el('div', { className: 'cua-card-title' }, [
        el('div', { className: 'cua-card-meta' }, [
          pill('等待设备接入', 'warn'),
          pill(card.platform === 'windows' ? 'Windows x64' : 'macOS', 'neutral'),
        ]),
        el('div', { className: 'cua-card-name' }, [el('strong', { text: '待接入新设备' })]),
      ]),
      removeBtn,
    ]),
    el('div', { className: 'row' }, [
      el('label', { text: '目标系统' }),
      platformSelect,
      copyBtn,
      card.expired ? reissueBtn : null,
    ]),
    el('div', { className: 'stack flat-stack' }, [
      el('small', { className: 'muted', text: expiresLabel }),
      cmdArea,
    ]),
    checklist,
    el('div', { className: 'cua-card-foot' }, [
      el('span', { className: 'muted small', text: '在目标设备运行命令后点击「刷新检测上线」完成接入。' }),
      refreshCheckBtn,
    ]),
  ]);
}

function renderDeviceCardNode(view: CuaDirectory, card: Device, scopes: ScopeChoice[]): HTMLElement {
  const saved = new Set(card.scopes);
  const draft = draftsBySpace.get(card.id) ?? new Set(saved);
  const allowNew = canGrantNew(view, card);
  const isBusy = savingSpaces.has(card.id) || pendingNameWrites().length > 0;
  const canRename = Boolean(view.online && view.available && !card.missing);
  const isRenaming = canRename && renamingSpaces.has(card.id);

  let toAdd = 0;
  let toRevoke = 0;
  for (const s of draft) if (!saved.has(s)) toAdd += 1;
  for (const s of saved) if (!draft.has(s)) toRevoke += 1;
  const dirty = toAdd > 0 || toRevoke > 0;

  const cardEl = el('article', { className: 'cua-card', 'data-space': card.id });

  const editBtn = canRename
    ? el('button', {
        type: 'button',
        className: 'btn compact',
        text: isRenaming ? '收起' : '改名',
        'aria-label': `更改设备名称 ${card.name}`,
        disabled: updating.has(card.id) || isBusy,
        onclick: () => {
          if (renamingSpaces.has(card.id)) {
            renamingSpaces.delete(card.id);
            renameDrafts.delete(card.id);
          } else {
            renamingSpaces.add(card.id);
            renameDrafts.set(card.id, card.alias ?? '');
          }
          renderAll();
          if (renamingSpaces.has(card.id)) {
            const inp = cardEl.ownerDocument.querySelector(`[data-rename-input="${CSS.escape(card.id)}"]`) as HTMLInputElement | null;
            inp?.focus();
          }
        },
      })
    : null;

  const metaItems: HTMLElement[] = [deviceStatusPill(view, card)];
  if (card.os) metaItems.unshift(pill(card.os, 'neutral'));

  const nameChildren: HTMLElement[] = [el('strong', { text: card.name })];
  if (card.alias && card.defaultName && card.defaultName !== card.alias) {
    nameChildren.push(el('small', { className: 'muted mono', text: `(${card.defaultName})` }));
  }

  const header = el('div', { className: 'cua-card-head' }, [
    el('div', { className: 'cua-card-title' }, [
      el('div', { className: 'cua-card-meta' }, metaItems),
      el('div', { className: 'cua-card-name' }, nameChildren),
    ]),
    editBtn,
  ]);

  let renameRow: HTMLElement | null = null;
  if (isRenaming) {
    const expectedName = card.alias ?? '';
    const defaultName = card.defaultName || card.name;
    const renamingNow = updating.has(card.id);
    const nameInput = el('input', {
      type: 'text',
      value: renameDrafts.get(card.id) ?? expectedName,
      placeholder: `默认名称 · ${defaultName}`,
      'aria-label': '设备显示名，最多 64 个字符',
      'data-rename-input': card.id,
      disabled: renamingNow,
      oninput: () => { renameDrafts.set(card.id, nameInput.value); },
    }) as HTMLInputElement;

    const saveNameBtn = el('button', { type: 'button', className: 'btn compact primary', text: '保存名称', disabled: renamingNow });
    const cancelBtn = el('button', {
      type: 'button',
      className: 'btn compact',
      text: '取消',
      disabled: renamingNow,
      onclick: () => {
        renamingSpaces.delete(card.id);
        renameDrafts.delete(card.id);
        renderAll();
      },
    });
    const restoreBtn = expectedName
      ? el('button', {
          type: 'button',
          className: 'btn compact',
          text: '恢复默认名称',
          disabled: renamingNow,
          onclick: () => {
            nameInput.value = '';
            renameDrafts.set(card.id, '');
            nameInput.focus();
          },
        })
      : null;

    async function submitRename() {
      if (savingSpaces.has(card.id) || updating.has(card.id) || directory !== view) return;
      const name = nameInput.value.trim();
      if ([...name].length > 64) { show('设备名称最多 64 个字符。', 'error'); return; }
      if (name === expectedName) {
        renamingSpaces.delete(card.id);
        renameDrafts.delete(card.id);
        renderAll();
        return;
      }
      const epoch = cs.epoch, token = readToken();
      if (!token) return;
      renameDrafts.set(card.id, nameInput.value);
      const finished = Promise.withResolvers<void>();
      updating.set(card.id, { epoch, token, done: finished.promise });
      renderAll();
      const isCurrent = () => directory === view && cs.epoch === epoch && readToken() === token;
      try {
        const result = await readApi(CuaNameResult, 'PUT', '/admin/cua/name', {
          space: card.id, name, expectedName, expectedRevision: view.revision,
        }, isCurrent);
        const nextAlias = result.name || undefined;
        const nextDisplay = result.name || defaultName;
        card.alias = nextAlias;
        card.name = nextDisplay;
        const raw = view.devices.find(d => d.id === card.id);
        if (raw) {
          raw.alias = nextAlias;
          raw.name = nextDisplay;
        }
        renamingSpaces.delete(card.id);
        renameDrafts.delete(card.id);
        show(result.name ? '设备名称已保存。' : '已恢复默认设备名称。', 'info');
      } catch (error) {
        if (isCurrent()) {
          if (error instanceof ApiError && error.status === 409) show('设备名称或目录已更新，请刷新后再试。', 'error');
          else fail(error);
        }
      } finally {
        updating.delete(card.id);
        finished.resolve();
        if (isCurrent()) renderAll();
      }
    }

    saveNameBtn.addEventListener('click', () => void submitRename());
    nameInput.addEventListener('keydown', event => {
      if (event.isComposing || updating.has(card.id)) return;
      if (event.key === 'Enter') { event.preventDefault(); void submitRename(); }
      if (event.key === 'Escape') {
        event.preventDefault();
        renamingSpaces.delete(card.id);
        renameDrafts.delete(card.id);
        renderAll();
      }
    });

    renameRow = el('div', { className: 'cua-rename-row' }, [nameInput, saveNameBtn, cancelBtn, restoreBtn]);
  }

  const metaRow = el('div', { className: 'cua-card-meta' }, [
    el('span', { className: 'muted small mono', text: `Space ID: ${card.id}` }),
    el('button', {
      type: 'button',
      className: 'btn compact',
      text: '复制 ID',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(card.id);
          show('设备 Space ID 已复制。', 'info');
        } catch {
          show(`设备 Space ID：${card.id}`, 'info');
        }
      },
    }),
    card.missing ? pill('仅可撤销已有授权', 'neutral') : null,
  ]);

  function setCardDraft(next: Set<string>) {
    const same = next.size === saved.size && [...saved].every(k => next.has(k));
    if (same) draftsBySpace.delete(card.id);
    else draftsBySpace.set(card.id, next);
    renderAll();
  }

  const checklist = createSessionChecklist({
    scopes,
    selected: draft,
    saved,
    filter: sessionFilterBySpace.get(card.id) ?? 'all',
    allowNew,
    busy: isBusy,
    isPending: false,
    onFilterChange: next => {
      sessionFilterBySpace.set(card.id, next);
      renderAll();
    },
    onToggle: (scopeKey, checked) => {
      if (!allowNew && !saved.has(scopeKey)) return;
      const next = new Set(draft);
      if (checked) next.add(scopeKey);
      else next.delete(scopeKey);
      setCardDraft(next);
    },
    onSelectAll: visibleKeys => {
      if (!allowNew) return;
      const next = new Set(draft);
      for (const k of visibleKeys) next.add(k);
      setCardDraft(next);
    },
    onClearVisible: visibleKeys => {
      const next = new Set(draft);
      for (const k of visibleKeys) next.delete(k);
      setCardDraft(next);
    },
  });

  const dirtyParts: string[] = [];
  if (toAdd > 0) dirtyParts.push(`待新增 ${toAdd}`);
  if (toRevoke > 0) dirtyParts.push(`待撤销 ${toRevoke}`);
  const dirtyText = dirtyParts.length ? dirtyParts.join(' · ') : '已同步';

  const discardBtn = el('button', {
    type: 'button',
    className: 'btn compact',
    text: '撤销改动',
    disabled: !dirty || isBusy,
    onclick: () => {
      draftsBySpace.delete(card.id);
      renderAll();
    },
  });

  const saveBtn = el('button', {
    type: 'button',
    className: 'btn compact primary',
    text: '保存授权',
    'data-save-device': card.id,
    disabled: !dirty || isBusy,
    onclick: () => void saveDeviceGrants(card.id),
  });

  const footer = el('div', { className: 'cua-card-foot' }, [
    el('span', { className: 'muted small', text: dirtyText }),
    el('div', { className: 'row' }, [discardBtn, saveBtn]),
  ]);

  cardEl.replaceChildren(
    header,
    ...(renameRow ? [renameRow] : []),
    metaRow,
    checklist,
    footer,
  );
  return cardEl;
}

function matchesSearch(q: string, card: Device, scopes: ScopeChoice[]): boolean {
  if (!q) return true;
  const hay = [card.name, card.alias, card.defaultName, card.id, card.os, card.status]
    .filter(Boolean)
    .map(v => String(v).toLowerCase());
  const draft = draftsBySpace.get(card.id) ?? new Set(card.scopes);
  for (const s of scopes) {
    if (draft.has(s.key)) {
      hay.push(s.key.toLowerCase());
      if (s.name) hay.push(s.name.toLowerCase());
    }
  }
  return hay.some(item => item.includes(q));
}

function renderAll() {
  const view = directory;
  const devices = mergedDevices(view);
  const scopes = scopeChoices(view);

  updateRelaySummary(view, devices, scopes);
  renderFilterBar(view, devices.all);
  updateTopActions();

  const q = searchQuery.trim().toLowerCase();
  const showPending = activeFilter === 'all' || activeFilter === 'pending';
  const showDevices = activeFilter !== 'pending';

  const visiblePending = showPending
    ? pendingCards.filter(p => !q || '待接入新设备 macos windows x64'.includes(q))
    : [];

  const visibleDevices = showDevices && view
    ? devices.all.filter(card => {
        const online = deviceOnlineForFilter(view, card);
        if (activeFilter === 'online' && !online) return false;
        if (activeFilter === 'offline' && online) return false;
        return matchesSearch(q, card, scopes);
      })
    : [];

  const nodes: HTMLElement[] = [
    ...visiblePending.map(card => renderPendingCardNode(card, scopes)),
    ...(view ? visibleDevices.map(card => renderDeviceCardNode(view, card, scopes)) : []),
  ];

  if (!nodes.length && view) {
    nodes.push(el('div', {
      className: 'cua-empty',
      text: devices.all.length || pendingCards.length
        ? '当前筛选或搜索条件下暂无匹配设备。'
        : '暂无设备卡。点击右上角「+ 添加设备」可将新机器接入当前工作区。',
    }));
  }

  $('cua-grant-devices').replaceChildren(...nodes);
}

async function saveDeviceGrants(space: string) {
  const view = directory;
  if (!view || savingSpaces.has(space) || pendingNameWrites().length) return;
  const deviceRow = mergedDevices(view).all.find(d => d.id === space);
  const saved = new Set(deviceRow?.scopes ?? []);
  const draft = draftsBySpace.get(space) ?? saved;
  const scopes = [...draft];

  savingSpaces.add(space);
  renderAll();
  const epoch = cs.epoch, token = readToken();
  const isCurrent = () => cs.epoch === epoch && readToken() === token;

  try {
    await readApi(CuaGrantList, 'PUT', '/admin/cua/device-grants', {
      space,
      scopes,
      expectedRevision: view.revision,
    }, isCurrent);
    draftsBySpace.delete(space);
    show('设备分配已保存。', 'info');
  } catch (error) {
    if (isCurrent()) {
      if (error instanceof ApiError && error.status === 409) show('设备分配已变更，请核对最新目录后重新选择。', 'error');
      else fail(error);
    }
  } finally {
    savingSpaces.delete(space);
    if (isCurrent()) await loadCuaGrants();
    else renderAll();
  }
}

async function issuePendingCard(existingCard?: PendingCard) {
  const epoch = cs.epoch, token = readToken();
  if (!token || issuingPair || !directory?.enabled || !directory.online) return;
  const isCurrent = () => cs.epoch === epoch && readToken() === token;
  issuingPair = true;
  updateTopActions();

  try {
    const { ticket, expires, origin } = await readApi(PairTicket, 'POST', '/admin/cua/pair', undefined, isCurrent);
    if (!isCurrent() || !directory?.online || !directory.enabled || expires <= Date.now()) return;

    const baselineIds = new Set(directory.devices.filter(d => Check(CuaDeviceId, d.id)).map(d => d.id));
    const card: PendingCard = existingCard ?? {
      id: `pending-${++pendingSequence}`,
      platform: 'mac',
      ticket,
      expires,
      origin,
      baselineIds,
      preScopes: [],
      sessionFilter: 'all',
      expired: false,
    };

    clearTimeout(card.timer);
    card.ticket = ticket;
    card.expires = expires;
    card.origin = origin;
    card.baselineIds = baselineIds;
    card.expired = false;
    card.timer = setTimeout(() => {
      card.ticket = '';
      card.expired = true;
      if (pendingCards.includes(card)) renderAll();
    }, Math.max(0, expires - Date.now()));
    if (typeof card.timer === 'object' && card.timer && 'unref' in card.timer) {
      (card.timer as { unref: () => void }).unref();
    }

    if (!existingCard) {
      pendingCards.unshift(card);
      if (activeFilter === 'online' || activeFilter === 'offline') activeFilter = 'all';
    }
    renderAll();
  } catch (error) {
    if (!isCurrent()) return;
    if (error instanceof ApiError && error.body?.error === 'pairing_full') show('VPS 的设备名额已用完。', 'error');
    else if (error instanceof ApiError && error.status === 503) show('VPS 配对服务不可用，请核对桥版本和设备接入配置。', 'error');
    else fail(error);
  } finally {
    issuingPair = false;
    updateTopActions();
  }
}

export async function loadCuaGrants() {
  clearTimeout(setupTimer);
  const wasPending = directory?.setup === 'pending';
  const version = ++sequence, epoch = cs.epoch, token = readToken();
  const isCurrent = () => version === sequence && epoch === cs.epoch && readToken() === token;

  // 标签页切换也会触发刷新。等待本次登录的名称写入落地，再读取同一目录。
  while (token && isCurrent()) {
    const writes = pendingNameWrites();
    if (!writes.length) break;
    await Promise.all(writes.map(write => write.done));
  }

  function scheduleSetupRefresh() {
    setupTimer = setTimeout(() => {
      if (isCurrent() && !$('cua-grants-section').closest('[hidden]')) void loadCuaGrants();
    }, 5000);
    if (typeof setupTimer === 'object' && setupTimer && 'unref' in setupTimer) {
      (setupTimer as { unref: () => void }).unref();
    }
  }

  if (!isCurrent()) return;
  if (!token) {
    clearAllCuaState();
    return;
  }

  directory = undefined;
  $('cua-setup-form').hidden = true;
  $('cua-grant-status').textContent = '正在读取设备目录和会话分配…';
  renderAll();

  try {
    const data = await readApi(CuaDirectory, 'GET', '/admin/cua/devices', undefined, isCurrent);
    const validDevices = data.devices.filter(row => Check(CuaDeviceId, row.id));
    for (const row of validDevices) row.defaultName ??= row.name;

    if (!(data.enabled && data.online)) {
      clearPendingCards();
    } else if (pendingCards.length === 1) {
      const pending = pendingCards[0]!;
      const newlyJoined = validDevices.filter(d => !pending.baselineIds.has(d.id));
      if (newlyJoined.length === 1) {
        const joined = newlyJoined[0]!;
        const pre = [...pending.preScopes];
        clearPendingCards();
        if (pre.length) draftsBySpace.set(joined.id, new Set([...joined.scopes, ...pre]));
        show(
          pre.length
            ? `新设备「${joined.name}」已上线，已带入 ${pre.length} 项预选授权，请核对后点击「保存授权」。`
            : `新设备「${joined.name}」已上线。`,
          'info',
        );
      }
    }

    directory = data;

    // 清理已经不再存在于当前目录且不在已保存授权中的草稿，避免失效设备长期滞留。
    const presentIds = new Set(mergedDevices(data).all.map(d => d.id));
    for (const spaceId of [...draftsBySpace.keys()]) {
      if (!presentIds.has(spaceId)) draftsBySpace.delete(spaceId);
    }

    $('cua-setup-form').hidden = data.setup !== 'new';
    if ($('cua-setup-form').hidden) $('cua-setup-token').value = '';
    if (data.setup === 'pending') scheduleSetupRefresh();

    $('cua-grant-status').textContent = data.setup === 'pending'
      ? (data.online ? 'VPS 已连接，正在检测工具。若持续未启用，请核对 VPS 桥版本。' : 'cs-agent 已保存配置，等待 VPS 连接。')
      : !data.configured ? '尚未配置 Cua 反向 MCP 服务。'
      : !data.enabled ? 'Cua 服务已停用。'
      : !data.online ? 'Cua 节点离线，可撤销已有分配。'
      : data.error ? '设备目录读取失败，可撤销已有分配。'
      : !data.available ? '请在 Cua 服务中启用 list_spaces 目录。'
      : !data.devices.length ? '控制节点尚未列出设备。'
      : !validDevices.length ? '当前目录的设备 ID 暂不支持分配。'
      : '';

    renderAll();
  } catch (error) {
    if (isCurrent()) {
      if (wasPending || (error instanceof ApiError && error.status === 409)) scheduleSetupRefresh();
      $('cua-grant-status').textContent = '读取失败，请刷新设备与分配。';
      renderAll();
      fail(error);
    }
  }
}

async function enableCua(event: SubmitEvent) {
  event.preventDefault();
  const epoch = cs.epoch, admin = readToken();
  if (!admin || enabling || directory?.setup !== 'new') return;
  const input = $('cua-setup-token'), token = input.value.trim();
  if (!Check(CuaBridgeToken, token)) {
    show('桥令牌需为 32 至 256 位，可用字母、数字及 . _ ~ -。', 'error');
    input.focus();
    return;
  }
  const isCurrent = () => cs.epoch === epoch && readToken() === admin;
  input.value = '';
  enabling = true;
  $('cua-setup-enable').disabled = true;
  try {
    await api('PUT', '/admin/cua/setup', { token }, isCurrent);
  } catch (error) {
    if (isCurrent()) {
      if (error instanceof ApiError && error.status === 409) show('Cua 已有其他配置，请在 MCP 服务中核对。', 'error');
      else fail(error);
    }
  } finally {
    enabling = false;
    $('cua-setup-enable').disabled = false;
    if (isCurrent()) await loadCuaGrants();
  }
}

export function initCuaGrants() {
  if (boundDoc === document) return;
  boundDoc = document;
  clearTimeout(setupTimer);
  clearPendingCards();
  directory = undefined;
  draftsBySpace.clear();
  sessionFilterBySpace.clear();
  renamingSpaces.clear();
  renameDrafts.clear();
  savingSpaces.clear();
  updating.clear();
  activeFilter = 'all';
  searchQuery = '';
  issuingPair = false;
  enabling = false;

  $('cua-pair-add').addEventListener('click', () => void issuePendingCard());
  $('cua-bridge-copy').addEventListener('click', async () => {
    const url = directory?.bridgeUrl;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      show('VPS 桥接地址已复制。', 'info');
    } catch {
      show(`VPS 桥接地址：${url}`, 'info');
    }
  });
  $('cua-search').addEventListener('input', event => {
    searchQuery = (event.target as HTMLInputElement).value;
    renderAll();
  });
  $('open-cua-settings').addEventListener('click', () => consoleView('access', 'access-cua-tab'));
  $('cua-setup-form').addEventListener('submit', enableCua);
  $('cua-grant-reload').addEventListener('click', () => void loadCuaGrants());
  document.addEventListener('cs-agent-logout', clearAllCuaState);
}

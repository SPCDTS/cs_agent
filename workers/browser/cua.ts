import { $, el, fail, readToken } from './app';
import { readApi } from './api';
import { cs } from './console';
import { SpaceDirectory, CUA_SERVER } from '../src/cua/spaces';
import { loadMcpServers, mcpServerRender } from './mcp-servers';

let request = 0;
async function loadSpaces() {
  if (!readToken()) return;
  const version = ++request, epoch = cs.epoch;
  const status = $('cua-status'), list = $('cua-list');
  list.replaceChildren();
  status.textContent = '正在读取 Cua Spaces…';
  try {
    const directory = await readApi(SpaceDirectory, 'GET', '/admin/cua/spaces');
    if (version !== request || epoch !== cs.epoch) return;
    status.textContent = !directory.configured ? '请配置并启用 Cua Spaces 的聚合 MCP。'
      : directory.spaces.length ? '' : 'Cua 账户中还没有 Space。';
    const phases: Record<string, string> = { ready: '可用', offline: '离线', 'not sharing': '已停止共享' };
    for (const space of directory.spaces) {
      list.append(el('div', { className: 'source' }, [
        el('strong', { text: space.name }),
        el('div', { className: 'muted small', text: [space.os, phases[space.status] ?? space.status, ...space.services, space.id].filter(Boolean).join(' · ') }),
      ]));
    }
  } catch (error) {
    if (version !== request || epoch !== cs.epoch) return;
    status.textContent = '无法读取 Cua 目录，请检查控制节点及其凭据。'; fail(error);
  }
}

export function initCua() {
  $('cua-panel').addEventListener('toggle', () => { if ($('cua-panel').open) void loadSpaces(); });
  $('cua-refresh').addEventListener('click', () => void loadSpaces());
  $('cua-login').addEventListener('click', async () => {
    try {
      await loadMcpServers(CUA_SERVER);
      $('mcp-server-editor').open = true;
      if ($('mcp-server-id').value !== CUA_SERVER) {
        mcpServerRender(''); $('mcp-server-id').value = CUA_SERVER; $('mcp-server-auth').value = 'token';
      }
      $('mcp-server-url').focus();
    } catch (error) { fail(error); }
  });
}

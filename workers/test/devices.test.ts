import { env, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { DeviceStore, deviceServerId } from '../src/devices/store';
import { DeviceTunnel } from '../src/devices/tunnel';
import { McpServerStore } from '../src/mcp/servers';
import { TokenVault } from '../src/mcp/crypto';
import { fakeRemote, adminEnv, TEST_STORE_KEY } from './mcp-helpers';
import worker from '../src/index';

afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const id = '11111111-1111-4111-8111-111111111111', tunnelId = '22222222-2222-4222-8222-222222222222';
const settings = { DEVICE_TUNNEL_ACCOUNT_ID: 'a'.repeat(32), DEVICE_TUNNEL_ZONE_ID: 'b'.repeat(32), DEVICE_TUNNEL_DOMAIN: 'example.test', DEVICE_TUNNEL_API_TOKEN: 'synthetic-cloudflare-token' };
const endpoint = `https://device-${id.replaceAll('-', '')}.example.test/mcp`;
function cloud() {
  const remote = fakeRemote(endpoint), upstream = remote.spy.getMockImplementation()!;
  remote.state.tools = ['device_info', 'shell_exec', 'shell_status', 'shell_cancel'].map(name => ({ name, inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }));
  const requests: { method: string; path: string; body: unknown }[] = [];
  let created = false, dns = false;
  remote.spy.mockImplementation(async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.hostname !== 'api.cloudflare.com') return upstream(input, init);
    expect(request.headers.get('authorization')).toBe('Bearer ' + settings.DEVICE_TUNNEL_API_TOKEN);
    const body: unknown = request.body ? await request.json() : undefined;
    requests.push({ method: request.method, path: url.pathname, body });
    let result: unknown;
    if (url.pathname.endsWith('/cfd_tunnel') && request.method === 'GET') result = created ? [{ id: tunnelId, name: 'cs-agent-device-' + id }] : [];
    else if (url.pathname.endsWith('/cfd_tunnel') && request.method === 'POST') { created = true; result = { id: tunnelId, name: 'cs-agent-device-' + id }; }
    else if (url.pathname.endsWith('/' + tunnelId)) result = { id: tunnelId, name: 'cs-agent-device-' + id };
    else if (url.pathname.endsWith('/configurations')) result = {};
    else if (url.pathname.endsWith('/token')) result = 'synthetic-tunnel-credential-do-not-expose';
    else if (url.pathname.endsWith('/dns_records')) {
      const record = { id: 'c'.repeat(32), name: new URL(endpoint).hostname, type: 'CNAME', content: tunnelId + '.cfargotunnel.com', proxied: true };
      if (request.method === 'POST') { dns = true; result = record; } else result = dns ? [record] : [];
    } else throw new Error('unexpected_cloudflare_request');
    return Response.json({ success: true, result });
  });
  return { remote, requests };
}
function stores(state: DurableObjectState) {
  const vault = new TokenVault(TEST_STORE_KEY), mcp = new McpServerStore(state.storage.sql, vault, env.PUBLIC_ORIGIN);
  mcp.initialize();
  const devices = new DeviceStore(state.storage.sql, vault, mcp, { ...env, ...settings }); devices.initialize();
  return { devices, mcp };
}
it('配对、断线重试、MCP 自动启用、凭据加密与撤销使用现有 Registry', async () => {
  const fixture = cloud(), registry = env.REGISTRY.getByName('main');
  await runInDurableObject(registry, async (_instance, state) => {
    const { devices, mcp } = stores(state), input = { id, name: '测试 Mac', desktop: false };
    const first = await devices.create(input), again = await devices.create(input);
    expect(again).toEqual(first);
    expect(fixture.requests.filter(request => request.method === 'POST' && request.path.endsWith('/cfd_tunnel'))).toHaveLength(1);
    expect(mcp.get(deviceServerId(id)).server.enabled).toBe(false);
    const token = new URL(first.pairingUrl).hash.slice(1), claim = 'a'.repeat(64);
    await expect(devices.claim(id, 'z'.repeat(43), claim)).rejects.toThrow('denied');
    const received = await devices.claim(id, token, claim);
    expect(received.desktopToken).toBeNull();
    expect(await devices.claim(id, token, claim)).toEqual(received);
    await expect(devices.claim(id, token, 'b'.repeat(64))).rejects.toThrow('already_claimed');
    const persisted = JSON.stringify(state.storage.sql.exec('SELECT * FROM devices').toArray());
    expect(persisted).not.toContain(token); expect(persisted).not.toContain(received.token); expect(persisted).not.toContain(received.tunnelToken);
    expect(JSON.stringify(devices.list())).not.toContain(token);
    expect((await devices.ready(id, token, claim)).state).toBe('ready');
    const enabled = mcp.get(deviceServerId(id));
    expect(enabled.server.tools.allow).toEqual(['device_info', 'shell_exec', 'shell_status', 'shell_cancel']);
    expect(enabled.server.tools.readOnly).toEqual(['device_info', 'shell_status']);
    expect(fixture.remote.requests.every(request => request.headers.get('authorization') === 'Bearer ' + received.token)).toBe(true);
    expect((await devices.revoke(id)).state).toBe('revoked');
    expect(mcp.get(deviceServerId(id)).server.enabled).toBe(false);
    await expect(devices.ready(id, token, claim)).rejects.toThrow('denied');
    expect(fixture.requests.at(-1)?.body).toEqual({ config: { ingress: [{ service: 'http_status:404' }] } });
  });
});
it('过期配对不可领取，桌面可选时复用同一个 Tunnel 并限定路由', async () => {
  const fixture = cloud();
  await runInDurableObject(env.REGISTRY.getByName('main'), async (_instance, state) => {
    const { devices, mcp } = stores(state);
    const created = await devices.create({ id, name: '桌面测试', desktop: true });
    const claim = await devices.claim(id, new URL(created.pairingUrl).hash.slice(1), 'a'.repeat(64));
    expect(claim.desktopToken).toMatch(/^[a-f0-9]{64}$/);
    const routes = fixture.requests.find(request => request.path.endsWith('/configurations'))?.body;
    expect(routes).toEqual({ config: { ingress: [
      { hostname: new URL(endpoint).hostname, path: '^/mcp$', service: `http://127.0.0.1:${claim.port}`, originRequest: { httpHostHeader: '127.0.0.1' } },
      { hostname: new URL(endpoint).hostname, path: '^/desktop/mcp$', service: `http://127.0.0.1:${claim.port + 1}`, originRequest: { httpHostHeader: '127.0.0.1' } },
      { service: 'http_status:404' },
    ] } });
    expect(mcp.get(deviceServerId(id) + '-desktop').server.enabled).toBe(false);
    state.storage.sql.exec('UPDATE devices SET expires=0 WHERE id=?', id);
    await expect(devices.claim(id, new URL(created.pairingUrl).hash.slice(1), 'a'.repeat(64))).rejects.toThrow('denied');
  });
});
it('管理员入口和配对入口分别鉴权，下载客户端不包含真实凭据', async () => {
  const response = await worker.fetch(new Request(env.PUBLIC_ORIGIN + '/admin/devices', { method: 'POST', body: '{}' }), adminEnv());
  expect(response.status).toBe(401);
  const malformed = await worker.fetch(new Request(`${env.PUBLIC_ORIGIN}/admin/devices/${id}/pair`, { method: 'POST', headers: { Authorization: 'Bearer ' + 'a'.repeat(43) }, body: JSON.stringify({ claim: 'b'.repeat(64), extra: true }) }), adminEnv());
  expect(await malformed.json()).toEqual({ error: 'device_invalid' });
  const browser = await worker.fetch(new Request(`${env.PUBLIC_ORIGIN}/admin/devices/${id}/pair`, { method: 'POST', headers: { Origin: 'https://other.test' }, body: JSON.stringify({ claim: 'b'.repeat(64) }) }), adminEnv());
  expect(browser.status).toBe(403);
  const client = await worker.fetch(new Request(env.PUBLIC_ORIGIN + '/admin/device-client.cjs'), adminEnv());
  expect(client.status).toBe(200); expect(client.headers.get('content-disposition')).toContain('cs-agent-device.cjs');
  const text = new TextDecoder().decode(await client.arrayBuffer()); expect(text).toContain('device_setup_failed'); expect(text).not.toContain(settings.DEVICE_TUNNEL_API_TOKEN);
});
it('Tunnel 失败只返回分类，不泄漏 Cloudflare 响应或 Token', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('sensitive-upstream-body', { status: 403 }));
  const tunnel = new DeviceTunnel({ account: settings.DEVICE_TUNNEL_ACCOUNT_ID, zone: settings.DEVICE_TUNNEL_ZONE_ID, domain: settings.DEVICE_TUNNEL_DOMAIN, token: settings.DEVICE_TUNNEL_API_TOKEN });
  await expect(tunnel.ensure(id)).rejects.toThrow('device_tunnel_forbidden');
});

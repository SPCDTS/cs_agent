import { Type, type Static, type TSchema } from 'typebox';
import { Check } from 'typebox/value';
import type { Env } from '../env';

export function tunnelSettings(env: Env) {
  const account = env.DEVICE_TUNNEL_ACCOUNT_ID, zone = env.DEVICE_TUNNEL_ZONE_ID;
  const domain = env.DEVICE_TUNNEL_DOMAIN?.toLowerCase(), token = env.DEVICE_TUNNEL_API_TOKEN;
  if (!account || !/^[a-f0-9]{32}$/.test(account) || !zone || !/^[a-f0-9]{32}$/.test(zone)
    || !domain || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/.test(domain) || domain.includes('..') || !token) throw new Error('device_tunnel_unconfigured');
  return { account, zone, domain, token };
}
export function tunnelConfigured(env: Env) { try { tunnelSettings(env); return true; } catch { return false; } }
const identifier = Type.String({ pattern: '^[a-f0-9-]{32,36}$' });
const Tunnel = Type.Object({ id: identifier, name: Type.String() });
const Dns = Type.Object({ id: identifier, name: Type.String(), type: Type.String(), content: Type.String(), proxied: Type.Boolean() });

export class DeviceTunnel {
  constructor(private readonly config: ReturnType<typeof tunnelSettings>) {}
  private async api<T extends TSchema>(path: string, schema: T, method = 'GET', body?: object): Promise<Static<T>> {
    let response: Response;
    try { response = await fetch('https://api.cloudflare.com/client/v4/' + path, { method, redirect: 'manual',
      headers: { Authorization: 'Bearer ' + this.config.token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) }); }
    catch { throw new Error('device_tunnel_network'); }
    if (!response.ok) throw new Error(response.status === 403 || response.status === 401 ? 'device_tunnel_forbidden' : 'device_tunnel_api_failed');
    const value: unknown = await response.json();
    const envelope = Type.Object({ success: Type.Literal(true), result: Type.Unknown() });
    if (!Check(envelope, value) || !Check(schema, value.result)) throw new Error('device_tunnel_response_invalid');
    return value.result;
  }
  private get base() { return `accounts/${this.config.account}/cfd_tunnel`; }
  async ensure(id: string, saved?: string) {
    const name = 'cs-agent-device-' + id;
    if (saved) {
      const tunnel = await this.api(this.base + '/' + saved, Tunnel);
      if (tunnel.name !== name) throw new Error('device_tunnel_identity_conflict');
      return tunnel.id;
    }
    const prior = await this.api(this.base + '?is_deleted=false&name=' + encodeURIComponent(name), Type.Array(Tunnel));
    const exact = prior.filter(row => row.name === name);
    if (exact.length > 1) throw new Error('device_tunnel_identity_conflict');
    return exact[0]?.id ?? (await this.api(this.base, Tunnel, 'POST', { name, config_src: 'cloudflare' })).id;
  }
  hostname(id: string) { return 'device-' + id.replaceAll('-', '') + '.' + this.config.domain; }
  async configure(id: string, tunnelId: string, port: number, desktop: boolean) {
    const hostname = this.hostname(id), originRequest = { httpHostHeader: '127.0.0.1' };
    const ingress = [
      { hostname, path: '^/mcp$', service: `http://127.0.0.1:${port}`, originRequest },
      ...(desktop ? [{ hostname, path: '^/desktop/mcp$', service: `http://127.0.0.1:${port + 1}`, originRequest }] : []),
      { service: 'http_status:404' },
    ];
    await this.api(this.base + '/' + tunnelId + '/configurations', Type.Unknown(), 'PUT', { config: { ingress } });
    const records = await this.api(`zones/${this.config.zone}/dns_records?name=${encodeURIComponent(hostname)}`, Type.Array(Dns));
    const content = tunnelId + '.cfargotunnel.com';
    if (records.some(row => row.name !== hostname || row.type !== 'CNAME' || row.content !== content || !row.proxied)) throw new Error('device_dns_conflict');
    const record = records[0] ?? await this.api(`zones/${this.config.zone}/dns_records`, Dns, 'POST', { type: 'CNAME', name: hostname, content, proxied: true });
    return { dnsId: record.id, token: await this.api(this.base + '/' + tunnelId + '/token', Type.String({ minLength: 20 })) };
  }
  async revoke(tunnelId: string) {
    // 先清空入口即可立即阻断连接。保留 Tunnel/DNS 身份，管理员可重试且不会误删其他资源。
    await this.api(this.base + '/' + tunnelId + '/configurations', Type.Unknown(), 'PUT', { config: { ingress: [{ service: 'http_status:404' }] } });
  }
}

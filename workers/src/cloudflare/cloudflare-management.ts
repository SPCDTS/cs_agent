import { isIP } from 'node:net';
import { Check } from 'typebox/value';
import { Type, type Static, type TSchema } from 'typebox';
import { createOAuthFetch } from '../mcp/oauth-fetch';
import { CloudflareChange, CloudflareInventory, DnsName, type Change } from './contracts';

type Target = { account: string; zone: string; domain: string; token: string };
type Pending = { id: string; account: string; zone: string; domain: string; payload: string; expires: number; status: string };
const origin = 'https://api.cloudflare.com', request = createOAuthFetch(() => [origin]);
const s = Type.String(), name = Type.Object({ name: s });
const listSchemas = {
  dns: Type.Array(Type.Object({ id: s, name: s, type: s, proxied: Type.Boolean() })),
  tunnels: Type.Array(Type.Object({ id: s, name: s, status: s })),
  buckets: Type.Object({ buckets: Type.Array(name) }),
};

async function cloudApi<T extends TSchema>(target: Target, path: string, schema: T, method = 'GET', body?: object): Promise<Static<T>> {
  const res = await request(origin + '/client/v4/' + path, { method, headers: { Authorization: 'Bearer ' + target.token,
    'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401 || res.status === 403) throw new Error('device_cloudflare_denied');
  if (res.status === 429) throw new Error('device_cloudflare_rate_limited');
  if ([400, 404, 409, 422].includes(res.status)) throw new Error('device_cloudflare_rejected');
  if (res.status >= 500) throw new Error('device_cloudflare_unavailable');
  const data: unknown = await res.json();
  if (!res.ok || !Check(Type.Object({ success: Type.Literal(true), result: Type.Unknown() }), data) || !Check(schema, data.result)) throw new Error('device_cloudflare_api');
  return data.result;
}

export class CloudflareManagement {
  constructor(private sql: SqlStorage, private authorized: (scope: string) => Promise<Target>) {}
  initialize() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS cf_changes (id TEXT PRIMARY KEY, account TEXT NOT NULL, zone TEXT NOT NULL,
      domain TEXT NOT NULL, payload TEXT NOT NULL, expires INTEGER NOT NULL, status TEXT NOT NULL)`);
    this.sql.exec("UPDATE cf_changes SET status='unknown' WHERE status='executing'");
  }
  async inventory(kind: Static<typeof CloudflareInventory>['resource'], page = 1) {
    if (!Check(CloudflareInventory, { resource: kind, page }) || kind !== 'workers' && page !== 1) throw new Error('device_invalid');
    const scope = { dns: 'dns.write', tunnels: 'argotunnel.write', workers: 'workers-scripts.metadata_read', buckets: 'workers-r2.write' }[kind];
    const t = await this.authorized(scope), account = 'accounts/' + t.account, zone = 'zones/' + t.zone;
    switch (kind) {
      case 'dns': return (await cloudApi(t, zone + '/dns_records?per_page=50', listSchemas.dns)).slice(0,50).map(({id,name,type,proxied}) => ({id,name,type,proxied}));
      case 'tunnels': return (await cloudApi(t, account + '/cfd_tunnel?is_deleted=false&per_page=50', listSchemas.tunnels)).slice(0,50).map(({id,name,status}) => ({id,name,status}));
      case 'workers': return (await cloudApi(t, account + '/workers/workers?per_page=50&order_by=name&order=asc&page=' + page, Type.Array(name))).slice(0,50).map(({name}) => ({ id: name }));
      case 'buckets': return (await cloudApi(t, account + '/r2/buckets?per_page=50', listSchemas.buckets)).buckets.slice(0,50).map(({name}) => ({name}));
      default: throw new Error('device_invalid');
    }
  }
  private validate(input: Change, domain: string) {
    if (!Check(CloudflareChange, input)) throw new Error('device_invalid');
    const inZone = (name: string) => name === domain || name.endsWith('.' + domain);
    if (input.action === 'dns_create') {
      const valid = input.type === 'CNAME' ? Check(DnsName, input.content.toLowerCase()) : isIP(input.content) === (input.type === 'A' ? 4 : 6);
      if (!valid || !inZone(input.name)) throw new Error('device_invalid');
    }
    if (input.action === 'cache_purge') {
      for (const raw of input.urls) {
        const url = URL.parse(raw);
        if (!url || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !inZone(url.hostname)) throw new Error('device_invalid');
      }
    }
  }
  private scope(input: Change) {
    return { dns_create:'dns.write', cache_purge:'cache.purge', bucket_create:'workers-r2.write' }[input.action];
  }
  async propose(input: Change) {
    if (!Check(CloudflareChange, input)) throw new Error('device_invalid');
    const { account, zone, domain } = await this.authorized(this.scope(input));
    this.validate(input, domain);
    const now = Date.now();
    this.sql.exec('DELETE FROM cf_changes WHERE expires<?', now - 7 * 86400000);
    if (this.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM cf_changes WHERE expires>? AND status='pending'", now).one().n >= 30) throw new Error('device_limit');
    const id = crypto.randomUUID(), expires = now + 10 * 60000;
    this.sql.exec('INSERT INTO cf_changes VALUES(?,?,?,?,?,?,?)', id, account, zone, domain, JSON.stringify(input), expires, 'pending');
    return { id, status: 'pending', expires };
  }
  list() {
    return this.sql.exec<Pending>('SELECT * FROM cf_changes ORDER BY expires DESC LIMIT 30').toArray().map(row => ({
      id: row.id, account: row.account, domain: row.domain, change: JSON.parse(row.payload) as Change, expires: row.expires,
      status: row.status === 'pending' && row.expires <= Date.now() ? 'expired' : row.status,
    }));
  }
  invalidate() { this.sql.exec("UPDATE cf_changes SET status='expired' WHERE status='pending'"); }
  async review(id: string, approve: boolean) {
    const row = this.sql.exec<Pending>("UPDATE cf_changes SET status=? WHERE id=? AND status='pending' AND expires>? RETURNING *",
      approve ? 'executing' : 'rejected', id, Date.now()).toArray()[0];
    if (!row) throw new Error('device_cloudflare_review_expired');
    if (!approve) return { status: 'rejected' };
    let sent = false;
    try {
      const change: Change = JSON.parse(row.payload);
      const t = await this.authorized(this.scope(change));
      if (t.account !== row.account || t.zone !== row.zone || t.domain !== row.domain) throw new Error('device_cloudflare_denied');
      this.validate(change, t.domain);
      sent = true;
      if (change.action === 'dns_create') {
        const { name, type, content, proxied } = change;
        await cloudApi(t, 'zones/' + t.zone + '/dns_records', Type.Unknown(), 'POST', { name,type,content,proxied,ttl:1 });
      } else if (change.action === 'cache_purge') {
        await cloudApi(t, 'zones/' + t.zone + '/purge_cache', Type.Unknown(), 'POST', { files: change.urls });
      } else {
        await cloudApi(t, 'accounts/' + t.account + '/r2/buckets', Type.Unknown(), 'POST', { name: change.name });
      }
      this.sql.exec("UPDATE cf_changes SET status='succeeded' WHERE id=?", id);
      return { status: 'succeeded' };
    } catch (error) {
      const rejected = error instanceof Error && ['device_cloudflare_denied', 'device_cloudflare_rejected'].includes(error.message);
      const unknown = sent && !rejected;
      this.sql.exec('UPDATE cf_changes SET status=? WHERE id=?', unknown ? 'unknown' : 'failed', id);
      if (unknown) throw new Error('device_cloudflare_unknown');
      throw error;
    }
  }
}

import { Type } from 'typebox';
import { Check } from 'typebox/value';
import type { Env } from '../env';
import { TokenVault, randomSecret, sha256 } from '../mcp/crypto';
import { publicOrigin } from '../mcp/config';
import { createOAuthFetch } from '../mcp/oauth-fetch';
import { Tokens, type OAuthTokens } from '../mcp/oauth';
import { tunnelSettings } from './tunnel';
import client from './cloudflare-client.json';

const dash = 'https://dash.cloudflare.com', api = 'https://api.cloudflare.com';
const cloudFetch = createOAuthFetch(() => [dash, api]);
const identifier = Type.String({ pattern: '^[a-f0-9]{32}$' });
const Zones = Type.Object({ success: Type.Literal(true), result: Type.Array(Type.Object({
  name: Type.String(), id: identifier, account: Type.Object({ id: identifier }), status: Type.String(),
})) });
const requestedScopes = [...client.scopes, ...client.optionalScopes, 'offline_access'].join(' ');
type Grant = { scopes: string; account: string; zone: string; domain: string; client: string; secret: string; expires: number; reauth: number };
const field = (id: string) => 'cloudflare:grant:' + id;

export class CloudflareGrant {
  constructor(private sql: SqlStorage, private vault: TokenVault, private env: Env) {}
  initialize() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS cf_login (state TEXT PRIMARY KEY, verifier TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cf_grant (id INTEGER PRIMARY KEY CHECK(id=1), account TEXT NOT NULL, zone TEXT NOT NULL,
        domain TEXT NOT NULL, client TEXT NOT NULL, secret TEXT NOT NULL, expires INTEGER NOT NULL, reauth INTEGER NOT NULL, scopes TEXT NOT NULL);`);
  }
  private row() { return this.sql.exec<Grant>('SELECT * FROM cf_grant WHERE id=1').toArray()[0]; }
  status() {
    const row = this.row();
    return { scopes: row?.scopes.split(' ') ?? [], available: !!this.env.DEVICE_CLOUDFLARE_OAUTH_CLIENT_ID && this.vault.configured, domain: row?.domain ?? null,
      reauth: !!row && (!!row.reauth || row.client !== this.env.DEVICE_CLOUDFLARE_OAUTH_CLIENT_ID) };
  }
  private get clientId() {
    if (!this.vault.configured || !this.env.DEVICE_CLOUDFLARE_OAUTH_CLIENT_ID) throw new Error('device_oauth_unconfigured');
    return this.env.DEVICE_CLOUDFLARE_OAUTH_CLIENT_ID;
  }
  private get redirect() { return publicOrigin(this.env.PUBLIC_ORIGIN) + client.callback; }
  async start() {
    const clientId = this.clientId, state = randomSecret(), verifier = randomSecret();
    const url = new URL('/oauth2/auth', dash);
    url.search = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: this.redirect, state,
      scope: requestedScopes, code_challenge_method: 'S256', code_challenge: (await sha256(verifier)).toString('base64url') }).toString();
    const encrypted = await this.vault.encrypt(verifier, JSON.stringify([clientId, this.redirect, state]));
    this.sql.exec('DELETE FROM cf_login WHERE expires<=?', Date.now());
    this.sql.exec('INSERT INTO cf_login VALUES(?,?,?)', state, encrypted, Date.now() + 10 * 60_000);
    return { url: url.href };
  }
  private async exchange(fields: Record<string,string>) {
    const response = await cloudFetch(dash + '/oauth2/token', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...fields, client_id: this.clientId }) });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok && Check(Type.Object({ error: Type.Literal('invalid_grant') }), value)) throw new Error('device_oauth_reauthorize');
    if (!response.ok || !Check(Tokens, value) || value.token_type.toLowerCase() !== 'bearer' || !value.expires_in) throw new Error('device_oauth_exchange');
    if (value.scope !== undefined && !client.scopes.every(scope => value.scope!.split(/\s+/).includes(scope))) throw new Error('device_oauth_scope');
    return value;
  }
  private async target(token: string) {
    const previous = this.row(), pinnedAccount = previous?.account ?? this.env.DEVICE_TUNNEL_ACCOUNT_ID;
    const pinnedZone = previous?.zone ?? this.env.DEVICE_TUNNEL_ZONE_ID;
    const pinnedDomain = previous?.domain ?? this.env.DEVICE_TUNNEL_DOMAIN?.toLowerCase();
    const labels = (pinnedDomain || new URL(this.redirect).hostname).split('.');
    while (labels.length > 1) {
      const domain = labels.join('.');
      const query = new URLSearchParams({ name: domain, status: 'active' });
      if (pinnedAccount) query.set('account.id', pinnedAccount);
      const response = await cloudFetch(api + '/client/v4/zones?' + query, { headers: { Authorization: 'Bearer ' + token } });
      const value: unknown = await response.json().catch(() => null);
      if (!response.ok || !Check(Zones, value)) throw new Error('device_oauth_zone');
      const matches = value.result.filter(z => z.name === domain && z.status === 'active' && (!pinnedZone || z.id === pinnedZone) && (!pinnedAccount || z.account.id === pinnedAccount));
      if (matches.length === 1) return { account: matches[0].account.id, zone: matches[0].id, domain };
      if (matches.length > 1 || pinnedDomain) break;
      labels.shift();
    }
    throw new Error('device_oauth_zone');
  }
  private async save(tokens: OAuthTokens, refresh: string, target: Pick<Grant,'account'|'zone'|'domain'>, previousScopes = client.scopes.join(' ')) {
    const id = this.clientId, secret = await this.vault.encrypt(JSON.stringify({ access: tokens.access_token, refresh }), field(id));
    const scopes = (tokens.scope ?? previousScopes).split(/\s+/).filter(s => s && requestedScopes.split(' ').includes(s));
    this.sql.exec('INSERT OR REPLACE INTO cf_grant(id,account,zone,domain,client,secret,expires,reauth,scopes) VALUES(1,?,?,?,?,?,?,0,?)',
      target.account, target.zone, target.domain, id, secret, Date.now() + tokens.expires_in! * 1000, scopes.join(' '));
  }
  async complete(state: string, code: string) {
    const row = this.sql.exec<{verifier:string}>('DELETE FROM cf_login WHERE state=? AND expires>? RETURNING verifier', state, Date.now()).toArray()[0];
    if (!row || !code || code.length > 8192) throw new Error('device_oauth_state');
    const verifier = await this.vault.decrypt(row.verifier, JSON.stringify([this.clientId, this.redirect, state]));
    const tokens = await this.exchange({ grant_type: 'authorization_code', redirect_uri: this.redirect, code, code_verifier: verifier });
    if (!tokens.refresh_token) throw new Error('device_oauth_refresh_missing');
    const target = await this.target(tokens.access_token);
    await this.save(tokens, tokens.refresh_token, target);
    return this.status();
  }
  // 宿主串行化换发与重新授权，避免并发设备覆盖已经轮换的 refresh token。
  async settings() {
    const row = this.row();
    if (!row) return tunnelSettings(this.env);
    if (row.client !== this.clientId || row.reauth) throw new Error('device_oauth_reauthorize');
    const saved: {access:string;refresh:string} = JSON.parse(await this.vault.decrypt(row.secret, field(row.client)));
    let token = saved.access;
    if (row.expires <= Date.now() + 60_000) {
      try {
        const fresh = await this.exchange({ grant_type: 'refresh_token', refresh_token: saved.refresh });
        await this.save(fresh, fresh.refresh_token ?? saved.refresh, row, row.scopes);
        token = fresh.access_token;
      } catch (error) {
        if (error instanceof Error && ['device_oauth_reauthorize','device_oauth_scope'].includes(error.message)) this.sql.exec('UPDATE cf_grant SET reauth=1 WHERE id=1');
        throw error;
      }
    }
    return { account: row.account, zone: row.zone, domain: row.domain, token };
  }
}

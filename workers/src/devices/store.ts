import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';
import { McpConnection } from '../mcp/connection';
import { MCP_CONFIG, publicOrigin } from '../mcp/config';
import { McpServerStore } from '../mcp/servers';
import { TokenVault, randomSecret, sha256 } from '../mcp/crypto';
import { DeviceTunnel, tunnelConfigured, tunnelSettings } from './tunnel';
import type { Env } from '../env';
import { DeviceCreate, DeviceView } from './contracts';
export { DeviceCreate } from './contracts';

const strict = { additionalProperties: false };
const Secrets = Type.Object({ pairing: Type.String(), shell: Type.String(), desktop: Type.String(), tunnel: Type.Optional(Type.String()) }, strict);
type Row = { id: string; name: string; desktop: number; state: Static<typeof DeviceView>['state']; created: number; expires: number; pairing_hash: string; claim_hash: string | null; secret: string; tunnel_id: string | null; dns_id: string | null };
const shellNames = ['device_info', 'shell_exec', 'shell_status', 'shell_cancel'];
const hex = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
const hashed = async (value: string) => (await sha256(value)).toString('hex');
export const deviceServerId = (id: string) => 'device-' + id;

export class DeviceStore {
  constructor(private readonly sql: SqlStorage, private readonly vault: TokenVault, private readonly mcp: McpServerStore, private readonly env: Env) {}
  initialize() { this.sql.exec(`CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,name TEXT NOT NULL,desktop INTEGER NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,pairing_hash TEXT NOT NULL,claim_hash TEXT,secret TEXT NOT NULL,tunnel_id TEXT,dns_id TEXT)`); }
  private row(id: string) { const row = this.sql.exec<Row>('SELECT * FROM devices WHERE id=?', id).toArray()[0]; if (!row) throw new Error('device_not_found'); return row; }
  private view(row: Row): Static<typeof DeviceView> { return { id: row.id, name: row.name, desktop: !!row.desktop, state: row.state, createdAt: row.created, expiresAt: row.expires,
    serverId: deviceServerId(row.id), desktopServerId: row.desktop ? deviceServerId(row.id) + '-desktop' : null }; }
  list() { return { configured: tunnelConfigured(this.env), devices: this.sql.exec<Row>('SELECT * FROM devices ORDER BY created DESC').toArray().map(row => this.view(row)) }; }
  private async secrets(row: Row) { const value: unknown = JSON.parse(await this.vault.decrypt(row.secret, 'device:' + row.id)); if (!Check(Secrets, value)) throw new Error('device_secret_invalid'); return value; }
  private async saveSecrets(id: string, value: Static<typeof Secrets>) { const ciphertext = await this.vault.encrypt(JSON.stringify(value), 'device:' + id); this.sql.exec('UPDATE devices SET secret=? WHERE id=?', ciphertext, id); }
  private port(id: string) { return 20000 + (parseInt(id.slice(0, 4), 16) % 10000) * 2; }
  async create(input: Static<typeof DeviceCreate>) {
    if (!Check(DeviceCreate, input)) throw new Error('device_invalid');
    const tunnel = new DeviceTunnel(tunnelSettings(this.env));
    const old = this.sql.exec<Row>('SELECT * FROM devices WHERE id=?', input.id).toArray()[0];
    if (old && (old.name !== input.name || !!old.desktop !== input.desktop)) throw new Error('device_conflict');
    if (!old) {
      if (this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM devices WHERE state!='revoked'").one().n >= 20) throw new Error('device_limit');
      const secrets = { pairing: randomSecret(), shell: hex(), desktop: hex() }, now = Date.now();
      const ciphertext = await this.vault.encrypt(JSON.stringify(secrets), 'device:' + input.id);
      this.sql.exec('INSERT INTO devices(id,name,desktop,state,created,expires,pairing_hash,secret) VALUES(?,?,?,?,?,?,?,?)', input.id, input.name, input.desktop ? 1 : 0, 'provisioning', now, now + 30 * 60000, await hashed(secrets.pairing), ciphertext);
    }
    let row = this.row(input.id);
    if (row.state === 'revoked' || row.state === 'ready') throw new Error('device_pairing_expired');
    if (row.expires <= Date.now()) {
      const secrets = await this.secrets(row); secrets.pairing = randomSecret();
      await this.saveSecrets(row.id, secrets);
      this.sql.exec('UPDATE devices SET pairing_hash=?,expires=? WHERE id=?', await hashed(secrets.pairing), Date.now() + 30 * 60000, row.id);
      row = this.row(row.id);
    }
    if (row.state === 'provisioning') {
      const tunnelId = await tunnel.ensure(row.id, row.tunnel_id ?? undefined);
      this.sql.exec('UPDATE devices SET tunnel_id=? WHERE id=?', tunnelId, row.id);
      const configured = await tunnel.configure(row.id, tunnelId, this.port(row.id), !!row.desktop);
      const secrets = await this.secrets(row); secrets.tunnel = configured.token;
      await this.saveSecrets(row.id, secrets);
      this.sql.exec('UPDATE devices SET dns_id=? WHERE id=?', configured.dnsId, row.id);
      for (const capability of row.desktop ? ['shell', 'desktop'] as const : ['shell'] as const) {
        const id = deviceServerId(row.id) + (capability === 'desktop' ? '-desktop' : '');
        const url = 'https://' + tunnel.hostname(row.id) + (capability === 'desktop' ? '/desktop/mcp' : '/mcp');
        // 失败后可重新准备同一设备；此时配对未开放，不会覆盖已接入的连接。
        const prior = this.mcp.list().find(record => record.server.id === id);
        const record = this.mcp.put({ id, url, auth: 'token' }, prior?.revision ?? 'absent');
        await this.mcp.credentialPut(id, record.revision, { Authorization: 'Bearer ' + secrets[capability] });
      }
      this.sql.exec("UPDATE devices SET state='pairing' WHERE id=?", row.id);
      row = this.row(row.id);
    }
    const secrets = await this.secrets(row);
    return { device: this.view(row), pairingUrl: publicOrigin(this.env.PUBLIC_ORIGIN) + '/admin/devices/' + row.id + '/pair#' + secrets.pairing };
  }
  private async authorize(id: string, token: string, claim: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !/^[a-f0-9]{64}$/.test(claim)) throw new Error('device_pairing_denied');
    const tokenHash = await hashed(token), claimHash = await hashed(claim);
    const row = this.row(id);
    if (row.pairing_hash !== tokenHash || row.expires <= Date.now() || row.state === 'revoked' || row.state === 'provisioning') throw new Error('device_pairing_denied');
    if (row.claim_hash && row.claim_hash !== claimHash) throw new Error('device_already_claimed');
    this.sql.exec('UPDATE devices SET claim_hash=? WHERE id=? AND claim_hash IS NULL', claimHash, id);
    return row;
  }
  async claim(id: string, token: string, claim: string) {
    const row = await this.authorize(id, token, claim), secrets = await this.secrets(row);
    if (!secrets.tunnel) throw new Error('device_not_prepared');
    return { id, name: row.name, port: this.port(id), token: secrets.shell, tunnelToken: secrets.tunnel, desktopToken: row.desktop ? secrets.desktop : null };
  }
  async ready(id: string, token: string, claim: string) {
    const row = await this.authorize(id, token, claim);
    if (row.state === 'ready') return this.view(row);
    // 命令与桌面分别验证，桌面未就绪时命令仍可启用。
    for (const desktop of row.desktop ? [false, true] : [false]) {
      const serverId = deviceServerId(id) + (desktop ? '-desktop' : ''), record = this.mcp.get(serverId);
      if (record.server.enabled) continue;
      let connection: McpConnection | undefined;
      try {
        connection = await McpConnection.open(record.server, this.env, MCP_CONFIG.limits, AbortSignal.timeout(15000), () => {});
        const tools = await connection.listTools(AbortSignal.timeout(15000));
        const allow = tools.map(tool => tool.name).filter(name => desktop ? name.startsWith('desktop_') : shellNames.includes(name));
        if (!desktop && !shellNames.every(name => allow.includes(name))) throw new Error('device_tools_missing');
        if (desktop && allow.length === 0) throw new Error('device_desktop_not_ready');
        if (!desktop) {
          const info = await connection.callTool('device_info', {}, { scope: '0'.repeat(64) }, AbortSignal.timeout(10000));
          if (info.isError) throw new Error('device_shell_not_ready');
        }
        const found = this.mcp.recordProbe(serverId, record.revision, { tools });
        const activated = this.mcp.activate(serverId, found.revision, { allow, readOnly: desktop ? [] : ['device_info', 'shell_status'] });
        if ('error' in activated) throw new Error('device_tools_rejected');
      } catch (error) {
        if (error instanceof Error && /^device_[a-z_]+$/.test(error.message)) throw error;
        throw new Error(desktop ? 'device_desktop_not_ready' : 'device_shell_not_ready');
      } finally { await connection?.close(); }
    }
    this.sql.exec("UPDATE devices SET state='ready' WHERE id=?", id);
    return this.view(this.row(id));
  }
  async revoke(id: string) {
    const row = this.row(id);
    this.sql.exec("UPDATE devices SET state='revoked',pairing_hash='',claim_hash=NULL WHERE id=?", id);
    for (const serverId of [deviceServerId(id), deviceServerId(id) + '-desktop']) {
      const record = this.mcp.list().find(record => record.server.id === serverId);
      if (record) this.mcp.disable(serverId, record.revision);
    }
    if (row.tunnel_id) await new DeviceTunnel(tunnelSettings(this.env)).revoke(row.tunnel_id);
    return this.view(this.row(id));
  }
}

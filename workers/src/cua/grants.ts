import { Check } from 'typebox/value';
import { CuaGrantInput, CuaScope, type CuaGrantList } from './contracts';

/** 配置和授权共用 Registry SQLite。连接变化与清退旧授权在同一次 SQL 写入中生效。 */
export class CuaGrants {
  constructor(private readonly storage: DurableObjectStorage) {}

  initialize() {
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS cua_device_grants (
      scope TEXT NOT NULL, space_id TEXT NOT NULL, server_revision TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(scope,space_id));
      CREATE INDEX IF NOT EXISTS cua_device_grants_space ON cua_device_grants(space_id);
      INSERT OR IGNORE INTO mcp_server_meta VALUES('cua_grants_revision',lower(hex(randomblob(16))));
      CREATE TRIGGER IF NOT EXISTS cua_grants_on_update AFTER UPDATE OF config ON mcp_servers
      WHEN NEW.id='cua' AND (json_extract(OLD.config,'$.access.revision') IS NOT json_extract(NEW.config,'$.access.revision')
        OR json_extract(OLD.config,'$.enabled') IS NOT json_extract(NEW.config,'$.enabled'))
      BEGIN DELETE FROM cua_device_grants;
        UPDATE mcp_server_meta SET value=lower(hex(randomblob(16))) WHERE key='cua_grants_revision'; END;
      CREATE TRIGGER IF NOT EXISTS cua_grants_on_delete AFTER DELETE ON mcp_servers WHEN OLD.id='cua'
      BEGIN DELETE FROM cua_device_grants;
        UPDATE mcp_server_meta SET value=lower(hex(randomblob(16))) WHERE key='cua_grants_revision'; END;`);
  }

  private revision() {
    return this.storage.sql.exec<{value:string}>("SELECT value FROM mcp_server_meta WHERE key='cua_grants_revision'").one().value;
  }

  active() {
    return this.storage.sql.exec<{revision:string}>(`SELECT json_extract(config,'$.access.revision') AS revision
      FROM mcp_servers WHERE id='cua' AND json_extract(config,'$.enabled')=1 AND secret IS NOT NULL
        AND json_extract(config,'$.transport.kind')='reverse-websocket'`).toArray()[0]?.revision;
  }

  assigned(scope: string, serverRevision: string): string[] {
    if (!Check(CuaScope, scope) || this.active() !== serverRevision) return [];
    return this.storage.sql.exec<{space_id:string}>(`SELECT space_id FROM cua_device_grants
      WHERE scope=? AND server_revision=? ORDER BY space_id`, scope, serverRevision).toArray().map(row => row.space_id);
  }

  list(): CuaGrantList {
    const byScope = new Map<string,string[]>();
    for (const row of this.storage.sql.exec<{scope:string; space_id:string}>(`SELECT scope,space_id FROM cua_device_grants
      WHERE server_revision=? ORDER BY scope,space_id`, this.active() ?? '')) {
      let ids = byScope.get(row.scope);
      if (!ids) { ids = []; byScope.set(row.scope, ids); }
      ids.push(row.space_id);
    }
    return {revision:this.revision(), grants:[...byScope].map(([scope,spaces]) => ({scope,spaces}))};
  }

  replace(input: CuaGrantInput, verifiedRevision?: string) {
    if (!Check(CuaGrantInput,input)) return {status:'invalid' as const};
    return this.storage.transactionSync(() => {
      const active = this.active();
      if (this.revision() !== input.expectedRevision || (input.spaces.length && (!active || active !== verifiedRevision))) {
        return {status:'conflict' as const};
      }
      const sql = this.storage.sql;
      sql.exec('DELETE FROM cua_device_grants WHERE scope=?',input.scope);
      const now = Date.now();
      for (const id of input.spaces) sql.exec('INSERT INTO cua_device_grants VALUES(?,?,?,?)',input.scope,id,active!,now);
      sql.exec("UPDATE mcp_server_meta SET value=? WHERE key='cua_grants_revision'",crypto.randomUUID());
      return {status:'ok' as const,...this.list()};
    });
  }
}

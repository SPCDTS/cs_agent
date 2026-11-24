import { Check } from 'typebox/value';
import { CuaGrantInput, CuaNameInput, CuaScope, type CuaGrantList } from './contracts';

/** 配置和授权共用 Registry SQLite。连接变化与清退旧授权在同一次 SQL 写入中生效。 */
export class CuaGrants {
  constructor(private readonly storage: DurableObjectStorage) {}

  initialize() {
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS cua_device_grants (
      scope TEXT NOT NULL, space_id TEXT NOT NULL, server_revision TEXT NOT NULL, updated_at INTEGER NOT NULL, grant_id TEXT NOT NULL,
      PRIMARY KEY(scope,space_id));
      CREATE INDEX IF NOT EXISTS cua_device_grants_space ON cua_device_grants(space_id);
      CREATE TABLE IF NOT EXISTS cua_device_names (space_id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS cua_names_on_replacement AFTER UPDATE OF config ON mcp_servers
      WHEN NEW.id='cua' AND json_extract(OLD.config,'$.credential.revision') IS NOT json_extract(NEW.config,'$.credential.revision')
      BEGIN DELETE FROM cua_device_names; END;
      CREATE TRIGGER IF NOT EXISTS cua_names_on_delete AFTER DELETE ON mcp_servers WHEN OLD.id='cua'
      BEGIN DELETE FROM cua_device_names; END;
      INSERT OR IGNORE INTO mcp_server_meta VALUES('cua_grants_revision',lower(hex(randomblob(16))));
      DROP TRIGGER IF EXISTS cua_grants_on_update;
      CREATE TRIGGER IF NOT EXISTS cua_grants_on_replacement AFTER UPDATE OF config ON mcp_servers
      WHEN NEW.id='cua' AND json_extract(OLD.config,'$.credential.revision') IS NOT json_extract(NEW.config,'$.credential.revision')
      BEGIN DELETE FROM cua_device_grants;
        UPDATE mcp_server_meta SET value=lower(hex(randomblob(16))) WHERE key='cua_grants_revision'; END;
      CREATE TRIGGER IF NOT EXISTS cua_grants_on_toggle AFTER UPDATE OF config ON mcp_servers
      WHEN NEW.id='cua' AND json_extract(OLD.config,'$.credential.revision') IS json_extract(NEW.config,'$.credential.revision')
        AND (json_extract(OLD.config,'$.enabled') IS NOT json_extract(NEW.config,'$.enabled')
          OR json_extract(OLD.config,'$.access.revision') IS NOT json_extract(NEW.config,'$.access.revision'))
      BEGIN UPDATE cua_device_grants SET server_revision=json_extract(NEW.config,'$.access.revision')
          WHERE server_revision=json_extract(OLD.config,'$.access.revision');
        UPDATE mcp_server_meta SET value=lower(hex(randomblob(16))) WHERE key='cua_grants_revision'; END;
      CREATE TRIGGER IF NOT EXISTS cua_grants_on_delete AFTER DELETE ON mcp_servers WHEN OLD.id='cua'
      BEGIN DELETE FROM cua_device_grants;
        UPDATE mcp_server_meta SET value=lower(hex(randomblob(16))) WHERE key='cua_grants_revision'; END;`);
    const sql = this.storage.sql;
    if (!sql.exec<{name:string}>('PRAGMA table_info(cua_device_grants)').toArray().some(row => row.name === 'grant_id')) {
      sql.exec("ALTER TABLE cua_device_grants ADD COLUMN grant_id TEXT NOT NULL DEFAULT ''");
      sql.exec('UPDATE cua_device_grants SET grant_id=lower(hex(randomblob(16)))');
    }
  }

  private revision() {
    return this.storage.sql.exec<{value:string}>("SELECT value FROM mcp_server_meta WHERE key='cua_grants_revision'").one().value;
  }

  private serverRevision(requireEnabled = true) {
    return this.storage.sql.exec<{revision:string}>(`SELECT json_extract(config,'$.access.revision') AS revision
      FROM mcp_servers WHERE id='cua' AND (?=0 OR json_extract(config,'$.enabled')=1) AND secret IS NOT NULL
        AND json_extract(config,'$.transport.kind')='reverse-websocket'`,Number(requireEnabled)).toArray()[0]?.revision;
  }

  names(ids: string[], serverRevision: string) {
    if (!ids.length || this.serverRevision() !== serverRevision) return {};
    const rows = this.storage.sql.exec<{space_id:string; name:string}>(`SELECT space_id,name FROM cua_device_names
      WHERE space_id IN (SELECT value FROM json_each(?))`,JSON.stringify(ids));
    return Object.fromEntries(Array.from(rows,row => [row.space_id,row.name])) as Record<string,string>;
  }

  rename(input: CuaNameInput, verifiedRevision: string) {
    if (!Check(CuaNameInput,input)) return {status:'invalid' as const};
    return this.storage.transactionSync(() => {
      const sql = this.storage.sql;
      const current = sql.exec<{name:string}>('SELECT name FROM cua_device_names WHERE space_id=?',input.space).toArray()[0]?.name ?? '';
      if (this.serverRevision() !== verifiedRevision || this.revision() !== input.expectedRevision || current !== input.expectedName)
        return {status:'conflict' as const};
      const name = input.name.trim();
      if (name) sql.exec('INSERT INTO cua_device_names VALUES(?,?) ON CONFLICT(space_id) DO UPDATE SET name=excluded.name',input.space,name);
      else sql.exec('DELETE FROM cua_device_names WHERE space_id=?',input.space);
      return {status:'ok' as const,name};
    });
  }

  assigned(scope: string, serverRevision: string): string[] {
    return Object.keys(this.grantVersions(scope,serverRevision));
  }

  grantVersions(scope: string, serverRevision: string): Record<string,string> {
    if (!Check(CuaScope,scope) || this.serverRevision() !== serverRevision) return {};
    const rows = this.storage.sql.exec<{space_id:string;grant_id:string}>(`SELECT space_id,grant_id FROM cua_device_grants
      WHERE scope=? AND server_revision=? ORDER BY space_id`,scope,serverRevision);
    return Object.fromEntries(Array.from(rows,row => [row.space_id,row.grant_id]));
  }

  list(): CuaGrantList {
    const byScope = new Map<string,string[]>();
    for (const row of this.storage.sql.exec<{scope:string; space_id:string}>(`SELECT scope,space_id FROM cua_device_grants
      WHERE server_revision=? ORDER BY scope,space_id`, this.serverRevision(false) ?? '')) {
      let ids = byScope.get(row.scope);
      if (!ids) { ids = []; byScope.set(row.scope, ids); }
      ids.push(row.space_id);
    }
    return {revision:this.revision(), grants:[...byScope].map(([scope,spaces]) => ({scope,spaces}))};
  }

  replace(input: CuaGrantInput, verifiedRevision?: string) {
    if (!Check(CuaGrantInput,input)) return {status:'invalid' as const};
    return this.storage.transactionSync(() => {
      if (this.revision() !== input.expectedRevision) return {status:'conflict' as const};
      const sql = this.storage.sql;
      const spaces = JSON.stringify(input.spaces);
      if (verifiedRevision !== undefined) {
        if (this.serverRevision() !== verifiedRevision) return {status:'conflict' as const};
        const now = Date.now();
        for (const id of input.spaces) sql.exec(`INSERT OR IGNORE INTO cua_device_grants(scope,space_id,server_revision,updated_at,grant_id)
          VALUES(?,?,?,?,lower(hex(randomblob(16))))`,input.scope,id,verifiedRevision,now);
      } else {
        // 停用或离线时仍可撤销已有分配。新增设备必须经过当前在线目录的核验。
        const existing = sql.exec<{n:number}>(`SELECT COUNT(*) AS n FROM cua_device_grants
          WHERE scope=? AND space_id IN (SELECT value FROM json_each(?))`,input.scope,spaces).one().n;
        if (existing !== input.spaces.length) return {status:'invalid' as const};
      }
      sql.exec('DELETE FROM cua_device_grants WHERE scope=? AND space_id NOT IN (SELECT value FROM json_each(?))',input.scope,spaces);
      sql.exec("UPDATE mcp_server_meta SET value=? WHERE key='cua_grants_revision'",crypto.randomUUID());
      return {status:'ok' as const,...this.list()};
    });
  }
}

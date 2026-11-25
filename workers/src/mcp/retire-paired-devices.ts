function removeOAuth(sql: SqlStorage, id: string) {
  sql.exec('DELETE FROM mcp_oauth_tokens WHERE server_id=?', id);
  sql.exec('DELETE FROM mcp_oauth_logins WHERE server_id=?', id);
  sql.exec('DELETE FROM mcp_oauth_client WHERE server_id=?', id);
}

function reserveCuaId(sql: SqlStorage, hasDevices: boolean) {
  const marker = 'reserved-cua-id-v1';
  if (sql.exec('SELECT 1 FROM mcp_server_meta WHERE key=?',marker).toArray().length) {
    if (hasDevices) removeOAuth(sql,'cua');
    return;
  }
  // 旧版允许任意 MCP 占用 cua，即使某条记录与新版反向配置相同，也不能继承其身份。
  removeOAuth(sql,'cua');
  sql.exec("DELETE FROM mcp_servers WHERE id='cua'");
  for (const action of ['INSERT','UPDATE']) {
    // 回滚版在提供 RPC 前会重建 devices；仅当它写入 cua 时撤销标记，读旧库不影响新版登记。
    sql.exec(`CREATE TRIGGER IF NOT EXISTS reserved_cua_on_legacy_${action} AFTER ${action} ON mcp_servers
      WHEN NEW.id='cua' AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='devices')
      BEGIN DELETE FROM mcp_server_meta WHERE key='reserved-cua-id-v1'; END`);
  }
  sql.exec('INSERT INTO mcp_server_meta(key,value) VALUES(?,?)',marker,'1');
}

/** 在 Registry 的初始化事务中清退旧设备。旧版回滚后会重新创建 devices，需要再次执行。 */
export function retirePairedDevices(sql: SqlStorage) {
  const hasDevices = sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='devices'").toArray().length > 0;
  reserveCuaId(sql,hasDevices);
  const marker = 'retired-device-pairing-v1';
  if (!hasDevices && sql.exec('SELECT 1 FROM mcp_server_meta WHERE key=?', marker).toArray().length) return;

  const ids = new Set<string>();
  if (hasDevices) {
    // 同名服务可能已被管理员重新登记。旧配对同时固定了服务 ID、Tunnel 主机名及 MCP 路径。
    for (const row of sql.exec<{ id: string; device: string; url: string }>(`SELECT s.id,d.id AS device,
          json_extract(s.config,'$.transport.url') AS url FROM mcp_servers s
        JOIN devices d ON d.id=substr(s.id,8,36)
        WHERE s.id IN ('device-'||d.id, 'device-'||d.id||'-desktop')`)) {
      const url = URL.parse(row.url);
      if (url?.protocol === 'https:' && !url.port && !url.search && !url.hash
          && url.hostname.startsWith('device-' + row.device.replaceAll('-', '') + '.')
          && url.pathname === (row.id.endsWith('-desktop') ? '/desktop/mcp' : '/mcp')) ids.add(row.id);
    }
    sql.exec('DROP TABLE devices');
  }
  sql.exec('DROP TABLE IF EXISTS device_tool_aliases');
  // 独立的旧桌面服务具有 desktop_skills_get 契约。windows 仍承载宿主机 WSB。
  if (sql.exec(`SELECT 1 FROM mcp_servers WHERE id='desktop' AND (
        EXISTS(SELECT 1 FROM json_each(config,'$.tools.allow') WHERE value='desktop_skills_get') OR
        EXISTS(SELECT 1 FROM json_each(discovered,'$.tools') WHERE json_extract(value,'$.name')='desktop_skills_get')
      )`).toArray().length) ids.add('desktop');

  for (const id of ids) {
    removeOAuth(sql,id);
    sql.exec('DELETE FROM mcp_servers WHERE id=?', id);
  }
  sql.exec('INSERT OR REPLACE INTO mcp_server_meta(key,value) VALUES(?,?)', marker, '1');
}

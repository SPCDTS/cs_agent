/** Registry 初始化事务中的一次性切换。按原配对记录和已知工具契约识别旧服务。 */
export function retireDeviceServers(sql: SqlStorage) {
  if (sql.exec("SELECT 1 FROM mcp_server_meta WHERE key='cua-cutover-v1'").toArray().length) return;
  const retired = new Set<string>();
  if (sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='devices'").toArray().length) {
    for (const row of sql.exec<{ id: string }>(`SELECT id FROM mcp_servers WHERE id IN (
      SELECT 'device-' || id FROM devices UNION ALL SELECT 'device-' || id || '-desktop' FROM devices)`))
      retired.add(row.id);
    sql.exec('DROP TABLE devices');
  }
  sql.exec('DROP TABLE IF EXISTS device_tool_aliases');
  for (const row of sql.exec<{ id: string }>(`SELECT id FROM mcp_servers WHERE id IN ('windows','desktop') AND EXISTS (
    SELECT 1 FROM json_each(mcp_servers.config, '$.tools.allow') WHERE value=CASE mcp_servers.id WHEN 'windows' THEN 'env_submit' ELSE 'desktop_skills_get' END
    UNION ALL SELECT 1 FROM json_each(mcp_servers.discovered, '$.tools') WHERE json_extract(value, '$.name')=CASE mcp_servers.id WHEN 'windows' THEN 'env_submit' ELSE 'desktop_skills_get' END
  )`)) retired.add(row.id);
  for (const id of retired) {
    sql.exec('DELETE FROM mcp_servers WHERE id=?', id);
    sql.exec('DELETE FROM mcp_oauth_tokens WHERE server_id=?', id);
    sql.exec('DELETE FROM mcp_oauth_logins WHERE server_id=?', id);
    sql.exec('DELETE FROM mcp_oauth_client WHERE server_id=?', id);
  }
  sql.exec("INSERT INTO mcp_server_meta VALUES ('cua-cutover-v1','1')");
}

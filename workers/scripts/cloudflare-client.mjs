import client from '../src/cloudflare/cloudflare-client.json' with { type: 'json' };

export async function ensureCloudflareClient(vars, env = process.env, request = fetch) {
  const pinned = vars.DEVICE_CLOUDFLARE_OAUTH_CLIENT_ID || env.DEVICE_CLOUDFLARE_OAUTH_CLIENT_ID;
  if (pinned) {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(pinned)) throw new Error('Cloudflare OAuth client ID 格式无效');
    return pinned;
  }
  if (!/^[0-9a-f]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID ?? '') || !env.CLOUDFLARE_API_TOKEN) {
    throw new Error('首次部署需要 CLOUDFLARE_ACCOUNT_ID 及具有 OAuth Clients Write 的 CLOUDFLARE_API_TOKEN，或指定已登记的 DEVICE_CLOUDFLARE_OAUTH_CLIENT_ID');
  }
  const endpoint = 'https://api.cloudflare.com/client/v4/accounts/' + env.CLOUDFLARE_ACCOUNT_ID + '/oauth_clients';
  const callback = new URL(client.callback, vars.PUBLIC_ORIGIN).href;
  const spec = { client_name: client.name, redirect_uris: [callback], scopes: [...client.scopes, ...client.optionalScopes], optional_scopes: client.optionalScopes,
    grant_types: ['authorization_code','refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
  async function call(url, method, body) {
    const res = await request(url, { method, headers: { Authorization: 'Bearer ' + env.CLOUDFLARE_API_TOKEN,
      'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('登记 OAuth 客户端失败（HTTP ' + res.status + '），请检查 OAuth Clients Write 权限和账户 ID');
    const data = await res.json();
    if (data.success !== true) throw new Error('Cloudflare OAuth 客户端 API 返回失败');
    return data;
  }
  const matches = [];
  for (let page = 1; ; page++) {
    const data = await call(endpoint + '?per_page=50&page=' + page, 'GET');
    if (!Array.isArray(data.result)) throw new Error('OAuth 客户端清单格式无效');
    matches.push(...data.result.filter(row => row.redirect_uris?.includes(callback)));
    const info = data.result_info;
    if (!data.result.length || (info?.total_count !== undefined ? page * (info.per_page ?? 50) >= info.total_count : data.result.length < 50)) break;
    if (page >= 200) throw new Error('OAuth 客户端清单超出分页限制');
  }
  if (matches.length > 1) throw new Error('多个客户端使用同一回调地址，请指定已核实的 client ID');
  const row = matches[0] ?? (await call(endpoint, 'POST', spec)).result;
  const same = (a,b) => Array.isArray(a) && a.length === b.length && b.every(x => a.includes(x));
  if (!row || row.visibility !== 'private' || row.token_endpoint_auth_method !== 'none' ||
    !same(row.redirect_uris,spec.redirect_uris) || !same(row.grant_types,spec.grant_types) || !same(row.response_types,spec.response_types)
    || !same(row.scopes?.filter(s => s !== 'offline_access'), spec.scopes) || !same(row.optional_scopes, spec.optional_scopes)
    || !/^[A-Za-z0-9_-]{8,128}$/.test(row.client_id ?? '')) throw new Error('相同回调地址的客户端配置不匹配，请核对 Cloudflare 登记');
  return row.client_id;
}

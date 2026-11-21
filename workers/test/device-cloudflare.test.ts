import { env, runInDurableObject, reset } from 'cloudflare:test';
import { afterEach, it, expect, vi } from 'vitest';
import { CloudflareGrant } from '../src/devices/cloudflare';
import { CloudflareManagement } from '../src/devices/cloudflare-management';
import { TokenVault, sha256 } from '../src/mcp/crypto';
import { TEST_STORE_KEY, adminEnv } from './mcp-helpers';
import worker from '../src/index';

afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const instance = { ...env, PUBLIC_ORIGIN:'https://agent.example.test', DEVICE_CLOUDFLARE_OAUTH_CLIENT_ID:'synthetic-client' };
const target = { account:'a'.repeat(32), zone:'e'.repeat(32), domain:'example.test', token:'synthetic-access' };
it('PKCE 回调仅使用一次，匹配活动父域，续期轮换加密令牌并区分授权撤销', async () => {
  await runInDurableObject(env.REGISTRY.getByName('main'), async (_instance, state) => {
    const grant = new CloudflareGrant(state.storage.sql, new TokenVault(TEST_STORE_KEY), instance);
    grant.initialize();
    const begin = new URL((await grant.start()).url), nonce = begin.searchParams.get('state')!;
    expect(begin.origin + begin.pathname).toBe('https://dash.cloudflare.com/oauth2/auth');
    expect(begin.searchParams.get('code_challenge_method')).toBe('S256');
    let refresh = 0;
    const scopes = 'zone.read dns.write argotunnel.write';
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const req = new Request(input, init), url = new URL(req.url);
      expect(req.redirect).toBe('manual');
      if (url.pathname === '/oauth2/token') {
        const body = new URLSearchParams(await req.text());
        if (body.get('grant_type') === 'authorization_code') {
          expect(body.get('redirect_uri')).toBe(begin.searchParams.get('redirect_uri'));
          expect((await sha256(body.get('code_verifier')!)).toString('base64url')).toBe(begin.searchParams.get('code_challenge'));
          return Response.json({token_type:'Bearer', access_token:target.token, refresh_token:'synthetic-refresh', expires_in:3600, scope:scopes});
        }
        expect(body.get('refresh_token')).toBe(refresh ? 'synthetic-rotated' : 'synthetic-refresh');
        return ++refresh === 1 ? Response.json({token_type:'Bearer',access_token:'synthetic-new',refresh_token:'synthetic-rotated',expires_in:3600})
          : Response.json({error:'invalid_grant'}, {status:400});
      }
      expect(url.pathname).toBe('/client/v4/zones');
      expect(req.headers.get('Authorization')).toBe('Bearer ' + target.token);
      const found = url.searchParams.get('name') === target.domain;
      return Response.json({ success: true, result: found ? [{ id:target.zone, name:target.domain, status:'active', account:{id:target.account} }] : [] });
    });
    await expect(grant.complete('wrong-state','code')).rejects.toThrow('state');
    expect(fetch).not.toHaveBeenCalled();
    expect((await grant.complete(nonce,'code')).domain).toBe(target.domain);
    await expect(grant.complete(nonce,'code')).rejects.toThrow('state');
    expect(await grant.settings()).toEqual(target);
    const saved = JSON.stringify(state.storage.sql.exec('SELECT * FROM cf_grant').toArray());
    expect(saved).not.toContain('synthetic-access'); expect(saved).not.toContain('synthetic-refresh');
    state.storage.sql.exec('UPDATE cf_grant SET expires=0');
    expect((await grant.settings()).token).toBe('synthetic-new');
    state.storage.sql.exec('UPDATE cf_grant SET expires=0');
    await expect(grant.settings()).rejects.toThrow('reauthorize');
    expect(grant.status().reauth).toBe(true);
  });
});
it('模型申请绑定资源，管理台批准只执行一次，拒绝或过期均无写操作', async () => {
  await runInDurableObject(env.REGISTRY.getByName('main'), async (_instance, state) => {
    const management = new CloudflareManagement(state.storage.sql, async () => target);
    management.initialize();
    const writes: unknown[] = [];
    vi.spyOn(globalThis,'fetch').mockImplementation(async (input,init) => {
      const req = new Request(input,init);
      if (req.method === 'POST') { writes.push(await req.json()); return Response.json({success:true,result:{id:'ok'}}); }
      return Response.json({success:true,result:[{id:'dns-id',name:'a.example.test',type:'A',proxied:true,content:'private-value'}]});
    });
    expect(JSON.stringify(await management.inventory('dns'))).not.toContain('private-value');
    await expect(management.propose({ action:'cache_purge', urls:['https://other.example/'] })).rejects.toThrow('device_invalid');
    await expect(management.propose({action:'dns_create', name:'demo.example.test',type:'AAAA',content:'invalid',proxied:false})).rejects.toThrow('device_invalid');
    const change = {action:'bucket_create' as const,name:'example-bucket'};
    const proposal = await management.propose(change);
    expect(management.list()[0].change).toEqual(change); expect(writes).toEqual([]);
    const answers = await Promise.allSettled([management.review(proposal.id,true),management.review(proposal.id,true)]);
    expect(answers.map(r=>r.status).sort()).toEqual(['fulfilled','rejected']); expect(writes).toEqual([{name:change.name}]);
    const rejected = await management.propose(change);
    await management.review(rejected.id,false); await expect(management.review(rejected.id,true)).rejects.toThrow('expired');
    const expired = await management.propose(change); management.invalidate();
    await expect(management.review(expired.id,true)).rejects.toThrow('expired');
    expect(writes).toHaveLength(1);
    const record = { action:'dns_create' as const,name:'demo.example.test',type:'A' as const,content:'192.0.2.1',proxied:false };
    const dns = await management.propose(record);
    await management.review(dns.id,true);
    expect(writes.at(-1)).toEqual({name:record.name,type:'A',content:record.content,proxied:false,ttl:1});
  });
});
it('只有回调可公开访问，浏览器二次提交和审批需要管理口令', async () => {
  const base = env.PUBLIC_ORIGIN + '/admin/devices/cloudflare';
  for (const path of ['/start','/complete','/changes/' + crypto.randomUUID() + '/approve']) {
    expect((await worker.fetch(new Request(base + path, {method:'POST'}), adminEnv())).status).toBe(401);
  }
  const response = await worker.fetch(new Request(base + '/callback?state=' + 's'.repeat(43) + '&code=sample'),adminEnv());
  expect(response.status).toBe(303); expect(response.headers.get('location')).toMatch(/^\/admin\/#cloudflare\?/);
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
});

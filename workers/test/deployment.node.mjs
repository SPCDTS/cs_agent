import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'jsonc-parser';
import { ensureCloudflareClient } from '../scripts/cloudflare-client.mjs';
import { deploymentConfig } from '../scripts/deploy.mjs';

test('正式部署首次登记私有客户端，再次部署复用；固定公开 ID 后不需要 IAM 凭据', async () => {
  const vars = {PUBLIC_ORIGIN:'https://agent.example.test'}, env = {CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'synthetic'};
  let client, created = 0;
  const request = async (_, opts) => {
    if (opts.method === 'POST') {
      created++; client = {...JSON.parse(opts.body),client_id:'synthetic-client',visibility:'private'};
      return Response.json({success:true,result:client});
    }
    return Response.json({success:true,result:client ? [client] : []});
  };
  assert.equal(await ensureCloudflareClient(vars,env,request),'synthetic-client');
  assert.equal(await ensureCloudflareClient(vars,env,request),'synthetic-client'); assert.equal(created,1);
  assert.deepEqual(client.redirect_uris,['https://agent.example.test/admin/devices/cloudflare/callback']);
  assert.equal(client.token_endpoint_auth_method,'none');
  assert.equal(await ensureCloudflareClient({...vars,DEVICE_CLOUDFLARE_OAUTH_CLIENT_ID:client.client_id},{},()=>assert.fail()),client.client_id);
  client.visibility = 'public'; await assert.rejects(ensureCloudflareClient(vars,env,request),/不匹配/);
});
const read = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
test('默认部署不连接维护者的资源，生产档案保留现有资源和全部迁移', async () => {
  const source = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const errors = [], base = parse(source, errors, { allowTrailingComma: true });
  assert.deepEqual(errors, []);
  assert.equal(base.routes, undefined);
  assert.equal(base.vars.GMAIL_PUBSUB_TOPIC, '');
  assert.deepEqual((await read('../mcp.json')).servers, []);
  const profile = await read('../deployments/production.json');
  const config = deploymentConfig(base, profile);
  assert.equal(config.name, 'cs-agent');
  assert.equal(config.r2_buckets[0].bucket_name, 'joule-bucket');
  assert.equal(config.vars.PUBLIC_ORIGIN, 'https://agent.spcdts.dev');
  assert.deepEqual(config.durable_objects, base.durable_objects);
  assert.deepEqual(config.migrations, base.migrations);
  assert.equal(config.migrations.at(-1).tag, 'v12');
  assert.throws(() => deploymentConfig(base, {...profile, migrations: []}));
  assert.throws(() => deploymentConfig(base, {...profile, vars: {PUBLIC_ORIGIN: 'https://agent.example.com'}}));
});

import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'jsonc-parser';
import { deploymentConfig } from '../scripts/deploy.mjs';

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

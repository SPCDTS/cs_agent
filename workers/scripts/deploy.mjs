import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse } from 'jsonc-parser';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// 部署档案只携带环境身份；绑定、迁移、构建规则仍只有 wrangler.jsonc 一份来源。
export function deploymentConfig(base, profile) {
  if (!object(base) || !object(profile) || Object.keys(profile).some(key => !['name', 'routes', 'r2_buckets', 'vars'].includes(key))) {
    throw new Error('部署档案仅允许 name、routes、r2_buckets、vars');
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(profile.name ?? '') || !object(profile.vars)) throw new Error('请配置 Worker 名称及 vars');
  const origin = new URL(profile.vars.PUBLIC_ORIGIN);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
    || /(^|\.)(example\.(com|org|net)|invalid|test|localhost)$/.test(origin.hostname)) throw new Error('PUBLIC_ORIGIN 必须是本次部署的真实 HTTPS 来源');
  if (!Array.isArray(profile.r2_buckets) || profile.r2_buckets.length !== 1 || profile.r2_buckets[0]?.binding !== 'ASSETS'
    || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(profile.r2_buckets[0]?.bucket_name ?? '')) throw new Error('请配置 ASSETS 的 R2 桶');
  if (profile.routes !== undefined && (!Array.isArray(profile.routes) || profile.routes.some(route => !object(route) || typeof route.pattern !== 'string'))) throw new Error('routes 格式无效');
  return { ...base, ...profile, vars: { ...base.vars, ...profile.vars } };
}

export async function prepareDeployment(profilePath) {
  const source = await readFile(resolve(root, 'wrangler.jsonc'), 'utf8');
  const errors = [];
  const base = parse(source, errors, { allowTrailingComma: true });
  if (errors.length) throw new Error('wrangler.jsonc 无效');
  const profile = JSON.parse(await readFile(resolve(root, profilePath), 'utf8'));
  const config = deploymentConfig(base, profile);
  const path = resolve(root, 'wrangler.deploy.json');
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return path;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [profile, ...args] = process.argv.slice(2);
    if (!profile || profile.startsWith('-')) throw new Error('用法：npm run deploy -- deployments/<档案>.json；不会自动选择生产环境');
    const path = await prepareDeployment(profile);
    if (args.includes('--prepare-only')) {
      if (args.length !== 1) throw new Error('--prepare-only 不能与部署参数混用');
      console.log('已生成部署配置：' + path);
    } else {
      const result = spawnSync(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), 'deploy', '--config', path, ...args], { cwd: root, stdio: 'inherit' });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : '部署配置失败');
    process.exitCode = 1;
  }
}

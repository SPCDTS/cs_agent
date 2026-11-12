import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from './config.ts';
import { atomicJson, exists, readJson } from './files.ts';
import { Jobs } from './jobs.ts';
import { acquireServiceLock } from './service-lock.ts';
import { createMcpHttpServer } from './server.ts';
import { createHypervBackend } from './hyperv.ts';
import { createWsbBackend } from './wsb.ts';
const args = process.argv.slice(2), action = args.shift();
function option(name: string, fallback: string) {
  const at = args.indexOf('--' + name); if (at < 0) return fallback;
  const value = args[at + 1]; if (!value || value.startsWith('--')) throw new Error('missing_' + name);
  args.splice(at, 2); return value;
}
const defaultDir = path.join(os.homedir(), '.cs-agent-windows-mcp');
async function prepareState(dir: string) {
  const marker = path.join(dir, 'windows-mcp-state.json');
  await fs.mkdir(dir, { recursive: true });
  if (await exists(marker)) {
    const value = await readJson(marker);
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1) throw new Error('invalid_state_marker');
    return;
  }
  if ((await fs.readdir(dir)).length) throw new Error('new_dedicated_state_directory_required');
  if (process.platform === 'win32') {
    const run = promisify(execFile);
    const identity = await run('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
    const sid = identity.stdout.match(/S-1-5-(?:[0-9]+-)*[0-9]+/)?.[0];
    if (!sid) throw new Error('windows_identity_unavailable');
    await run('icacls.exe', [dir, '/inheritance:r', '/grant:r', '*' + sid + ':(OI)(CI)F', '*S-1-5-18:(OI)(CI)F'], { windowsHide: true });
  }
  await atomicJson(marker, { version: 1 });
}
async function main() {
  if (action === 'init') {
    const state = path.resolve(option('state', defaultDir)); if (args.length) throw new Error('unknown_arguments');
    if (state === path.parse(state).root) throw new Error('dedicated_state_directory_required');
    await prepareState(state);
    const file = path.join(state, 'config.json'); if (await exists(file)) throw new Error('config_already_exists');
    await atomicJson(file, { stateDir: state, host: '127.0.0.1', port: 7791, principals: [{ id: 'cs_agent', tokenEnv: 'WINDOWS_MCP_TOKEN' }], targets: [{ kind: 'wsb', id: 'temp', memoryMb: 6144, idleTimeoutMs: 600000, maxLifetimeMs: 3600000 }] });
    console.log('配置已生成：' + file + '\n请按 docs/WINDOWS-MCP.md 配置 VM、凭据和 token，再运行 run。旧 WSB 目录没有迁移或挂载。');
  } else if (action === 'run' || action === 'inspect') {
    const file = path.resolve(option('config', path.join(defaultDir, 'config.json'))); if (args.length) throw new Error('unknown_arguments');
    const config = await loadConfig(file);
    if (action === 'inspect') { console.log(JSON.stringify({ endpoint: `http://${config.host}:${config.port}/mcp`, targets: config.targets.map(t => ({ id: t.id, kind: t.kind, instructions: t.instructions, ...(t.kind === 'hyperv' ? { vmId: t.vmId, guestWorkdir: t.guestWorkdir } : { memoryMb: t.memoryMb, idleTimeoutMs: t.idleTimeoutMs, maxLifetimeMs: t.maxLifetimeMs }) })) }, null, 2)); return; }
    if (process.platform !== 'win32') throw new Error('windows_required');
    await prepareState(config.stateDir);
    const releaseLock = acquireServiceLock(config.stateDir);
    const backends = { hyperv: createHypervBackend(config.stateDir), wsb: createWsbBackend(config.stateDir) };
    const jobs = new Jobs(config.stateDir, backends);
    try {
      jobs.bindTargets(config.targets);
      const server = createMcpHttpServer(config, jobs);
      server.requestTimeout = 30000; server.headersTimeout = 10000;
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
      jobs.start(); console.log(`Windows MCP 正在监听 http://${config.host}:${config.port}/mcp`);
      await new Promise<void>(resolve => {
        const stop = () => { server.close(() => resolve()); server.closeIdleConnections(); };
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
      });
    } finally { await jobs.shutdown(); releaseLock(); }
  } else console.log('用法：\n  npm start -- init [--state 新专用目录]\n  npm start -- inspect [--config 配置文件]\n  npm start -- run [--config 配置文件]\n详细接入与 Hyper-V 准备见 docs/WINDOWS-MCP.md。');
}
await main().catch(error => { console.error(error instanceof Error ? error.message : 'windows_mcp_failed'); process.exitCode = 1; });

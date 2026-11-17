import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile, appendFile, stat, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { Check } from 'typebox/value';
import { Type } from 'typebox';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DeviceShell, defaultShell } from './device-shell.ts';
import { createDeviceServer } from './device-server.ts';
import { createDesktopServer } from './desktop-server.ts';
import { acquireServiceLock } from './service-lock.ts';
import { Enrollment, loadConfig, saveConfig, protectDirectory, statePath, type Config } from './device-config.ts';
import { installTunnel, installDesktop, installStartup, removeStartup } from './device-install.ts';

const output = (value: string) => process.stdout.write(value + '\n');
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function enrollmentCall(pairing: NonNullable<Config['pairing']>, ready = false) {
  const url = new URL(pairing.url);
  if (ready) url.pathname = url.pathname.replace(/\/pair$/, '/ready');
  const response = await fetch(url, { method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer ' + pairing.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ claim: pairing.claim }), signal: AbortSignal.timeout(45000) });
  const value: unknown = await response.json();
  if (!response.ok) {
    const error = Check(Type.Object({ error: Type.String({ pattern: '^device_[a-z_]+$' }) }), value) ? value.error : 'device_pairing_failed';
    throw new Error(error);
  }
  return value;
}
async function pair(directory: string, workdir?: string) {
  await protectDirectory(directory);
  let previous: Config | undefined;
  try { previous = await loadConfig(directory); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  const raw = (await reader.question('粘贴管理页生成的配对链接：')).trim(); reader.close();
  const url = new URL(raw), token = url.hash.slice(1);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || !/^\/admin\/devices\/[a-f0-9-]{36}\/pair$/.test(url.pathname) || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('device_pairing_url_invalid');
  if (previous && !url.pathname.includes('/' + previous.enrollment.id + '/')) throw new Error('device_already_configured_use_separate_state_dir');
  url.hash = '';
  const pendingFile = path.join(directory, 'pairing.json');
  let claim = randomBytes(32).toString('hex');
  try {
    const prior: unknown = JSON.parse(await readFile(pendingFile, 'utf8'));
    if (Check(Type.Object({ url: Type.String(), token: Type.String(), claim: Type.String({ pattern: '^[a-f0-9]{64}$' }) }), prior) && prior.url === url.href) claim = prior.claim;
  } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  const pairing = { url: url.href, token, claim };
  await writeFile(pendingFile, JSON.stringify(pairing), { encoding: 'utf8', mode: 0o600 });
  const enrollment = await enrollmentCall(pairing);
  if (!Check(Enrollment, enrollment)) throw new Error('device_pairing_response_invalid');
  output('正在准备命令行服务和 Cloudflare Tunnel…');
  const cloudflared = await installTunnel(directory);
  const desktop = enrollment.desktopToken ? await installDesktop(directory) : null;
  const config: Config = { version: 1, enrollment, workdir: path.resolve(workdir ?? previous?.workdir ?? path.join(os.homedir(), 'AgentWork')), shell: previous?.shell ?? defaultShell(), cloudflared, desktop, pairing };
  await saveConfig(directory, config);
  await installStartup(directory, process.argv[1]);
  output('已安装登录自启动。正在验证云端连接…');
  await verify(directory);
}
async function verify(directory: string) {
  const config = await loadConfig(directory);
  if (!config.pairing) { output('配对已完成；使用 status 查看本机服务。'); return; }
  const pairing = config.pairing;
  let reason = 'device_shell_not_ready';
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      await enrollmentCall(pairing, true);
      config.pairing = null; await saveConfig(directory, config);
      const { unlink } = await import('node:fs/promises'); await unlink(path.join(directory, 'pairing.json')).catch(() => {});
      output('设备已接入，命令行可在 cs-agent 中使用。' + (config.desktop ? '桌面能力也已启用。' : '桌面能力未安装。')); return;
    } catch (error) {
      reason = error instanceof Error ? error.message : reason;
      if (!['device_shell_not_ready', 'device_desktop_not_ready'].includes(reason)) throw error;
      if (attempt === 0) output('等待 Tunnel 生效；桌面能力如未授权，请在系统设置完成权限后运行 verify。');
      await delay(5000);
    }
  }
  throw new Error(reason + '_retry_verify');
}
async function serve(directory: string) {
  const config = await loadConfig(directory), release = acquireServiceLock(directory);
  const shell = new DeviceShell({ stateDir: directory, workdir: config.workdir, shell: config.shell });
  const server = createDeviceServer(shell, config.enrollment.token, config.enrollment.name);
  let stopped = false;
  let desktop: ReturnType<typeof createDesktopServer> | undefined;
  let connector: ReturnType<typeof spawn> | undefined;
  let retry: NodeJS.Timeout | undefined;
  const logFile = path.join(directory, 'service.log');
  const log = async (event: string) => {
    if (((await stat(logFile).catch(() => undefined))?.size ?? 0) > 1024 * 1024) await rename(logFile, logFile + '.old').catch(() => {});
    await appendFile(logFile, JSON.stringify({ at: new Date().toISOString(), event }) + '\n', { encoding: 'utf8', mode: 0o600 }).catch(() => {});
  };
  const close = async () => {
    if (stopped) return; stopped = true; clearTimeout(retry); connector?.kill();
    await desktop?.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await shell.close(); release();
  };
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.enrollment.port, '127.0.0.1', resolve); });
    if (config.desktop && config.enrollment.desktopToken) {
      const stamp = randomBytes(16).toString('hex');
      desktop = createDesktopServer({ host: '127.0.0.1', port: config.enrollment.port + 1, token: config.enrollment.desktopToken,
        command: config.desktop.command, args: config.desktop.args, cwd: config.workdir, desktopSid: os.userInfo().username, scopeArgument: '--session' }, async () => stamp,
      { path: '/desktop/mcp', instructions: '这是设备已登录用户的真实桌面，与用户及其他会话共享窗口和文件。首次使用读取 desktop/platform 指南。锁屏或权限不足时先处理系统授权；未知结果先观察，禁止盲目重放。' });
      await new Promise<void>((resolve, reject) => { desktop!.server.once('error', reject); desktop!.server.listen(config.enrollment.port + 1, '127.0.0.1', resolve); });
    }
    const tokenFile = path.join(directory, 'tunnel-token');
    await writeFile(tokenFile, config.enrollment.tunnelToken, { encoding: 'utf8', mode: 0o600 });
    const connect = () => {
      connector = spawn(config.cloudflared, ['tunnel', '--no-autoupdate', 'run', '--token-file', tokenFile], { windowsHide: true, stdio: 'ignore' });
      connector.once('error', () => { void log('tunnel_start_failed'); });
      connector.once('close', () => { if (!stopped) { void log('tunnel_reconnecting'); retry = setTimeout(connect, 5000); } });
    };
    connect(); await log('device_started');
    process.once('SIGINT', () => { void close(); }); process.once('SIGTERM', () => { void close(); });
  } catch (error) { await close(); throw error; }
}
async function status(directory: string) {
  const config = await loadConfig(directory), client = new Client({ name: 'device-status', version: '1' });
  try {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${config.enrollment.port}/mcp`), { requestInit: { headers: { Authorization: 'Bearer ' + config.enrollment.token } } });
    await client.connect(transport, { signal: AbortSignal.timeout(5000) });
    const result = await client.callTool({ name: 'device_info', arguments: {} });
    output(JSON.stringify({ device: config.enrollment.name, command: 'ready', desktop: config.desktop ? 'configured' : 'disabled', info: result.structuredContent }, null, 2));
  } finally { await client.close(); }
}
async function permissions(directory: string) {
  const config = await loadConfig(directory);
  if (!config.desktop) throw new Error('device_desktop_disabled');
  const desktop = config.desktop;
  const args = desktop.args.slice(0, desktop.args.indexOf('mcp'));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(desktop.command, [...args, 'permissions', '--guide'], { stdio: 'inherit' });
    child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('device_desktop_permissions_required')));
  });
}
async function main() {
  process.env.NO_PROXY = [process.env.NO_PROXY, '127.0.0.1', 'localhost'].filter(Boolean).join(',');
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'state-dir': { type: 'string' }, workdir: { type: 'string' } } });
  const directory = path.resolve(values['state-dir'] ?? statePath());
  switch (positionals[0]) {
    case 'pair': return pair(directory, values.workdir);
    case 'run': return serve(directory);
    case 'verify': return verify(directory);
    case 'status': return status(directory);
    case 'permissions': return permissions(directory);
    case 'install-service': return installStartup(directory, process.argv[1]);
    case 'remove-service': return removeStartup(directory);
    default: output('cs-agent 设备接入（Node.js 24+）\npair：粘贴一次性配对链接，安装并启动服务\nrun：前台运行\nverify：重试云端检测\nstatus：查看本机命令服务\npermissions：可选桌面组件的系统权限引导\ninstall-service / remove-service：管理登录自启动\n--state-dir <目录>  --workdir <默认工作目录>');
  }
}
void main().catch(error => {
  const code = error instanceof Error && /^[a-z][a-z0-9_]{0,100}$/.test(error.message) ? error.message : 'device_setup_failed';
  const guidance: Record<string, string> = {
    device_shell_not_ready_retry_verify: '本机服务或 Tunnel 尚未就绪。运行 status 检查本机，再运行 verify 重试云端检测。',
    device_desktop_not_ready_retry_verify: '命令能力已检测通过。桌面尚未就绪，请在登录用户的会话运行 permissions 完成系统授权，再运行 verify。',
    device_pairing_denied: '配对链接无效或已过期。在管理页点击继续配对，再在原设备运行 pair。',
    device_already_claimed: '此链接已经绑定另一客户端。请在原设备继续，或在管理页撤销后新增设备。',
    device_tunnel_unconfigured: '实例管理员尚未完成设备 Tunnel 配置，请查看管理页的配置提示。',
    service_lock_unavailable: '当前状态目录已有客户端在运行。可用 status 检查，避免重复启动。',
    device_setup_failed: '安装或启动未完成。已保存的配对可以继续；检查 Node.js 版本、网络和当前用户的自启动权限。',
  };
  process.stderr.write(code + (guidance[code] ? '\n' + guidance[code] : '') + '\n'); process.exitCode = 1;
});

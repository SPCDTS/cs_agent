import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { Type } from 'typebox';
import { Check } from 'typebox/value';

const run = promisify(execFile);
const assetSchema = Type.Object({ name: Type.String(), browser_download_url: Type.String(), digest: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }), size: Type.Number() });
const releaseSchema = Type.Object({ tag_name: Type.String(), assets: Type.Array(Type.Object({ name: Type.String() })) });
export async function installTunnel(directory: string) {
  const executable = path.join(directory, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  try { await access(executable); await run(executable, ['--version'], { windowsHide: true, timeout: 10000 }); return executable; } catch {}
  const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : undefined;
  if (!arch || !['win32', 'darwin', 'linux'].includes(process.platform)) throw new Error('device_platform_unsupported');
  const assetName = process.platform === 'win32' ? `cloudflared-windows-${arch}.exe` : process.platform === 'darwin' ? `cloudflared-darwin-${arch}.tgz` : `cloudflared-linux-${arch}`;
  const response = await fetch('https://api.github.com/repos/cloudflare/cloudflared/releases/latest', { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('cloudflared_release_unavailable');
  const release: unknown = await response.json();
  if (!Check(releaseSchema, release)) throw new Error('cloudflared_release_invalid');
  const asset = release.assets.find(candidate => candidate.name === assetName);
  if (!Check(assetSchema, asset) || asset.size > 100 * 1024 * 1024 || !asset.browser_download_url.startsWith('https://github.com/cloudflare/cloudflared/releases/download/')) throw new Error('cloudflared_asset_unavailable');
  const download = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(180000) });
  if (!download.ok || !download.body) throw new Error('cloudflared_download_failed');
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of download.body) { size += chunk.length; if (size > asset.size) throw new Error('cloudflared_size_mismatch'); chunks.push(chunk); }
  const bytes = Buffer.concat(chunks);
  if (size !== asset.size || 'sha256:' + createHash('sha256').update(bytes).digest('hex') !== asset.digest) throw new Error('cloudflared_checksum_mismatch');
  if (process.platform === 'darwin') {
    const archive = path.join(directory, 'cloudflared.tgz');
    await writeFile(archive, bytes, { mode: 0o600 });
    await run('/usr/bin/tar', ['-xzf', archive, '-C', directory, 'cloudflared'], { timeout: 30000 });
  } else await writeFile(executable, bytes, { mode: 0o700 });
  await chmod(executable, 0o700);
  await run(executable, ['--version'], { windowsHide: true, timeout: 10000 });
  return executable;
}
export async function installDesktop(directory: string) {
  const prefix = path.join(directory, 'desktop');
  // 固定入口包，npm 记录下载包的完整性；仅在用户启用桌面能力时安装。
  const npm = process.platform === 'win32' ? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js') : undefined;
  if (npm) await run(process.execPath, [npm, 'install', '--prefix', prefix, '--no-audit', '--no-fund', 'agent-desktop@1.3.0'], { windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024 });
  else await run('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', 'agent-desktop@1.3.0'], { timeout: 180000, maxBuffer: 1024 * 1024 });
  const pkgFile = path.join(prefix, 'node_modules', 'agent-desktop', 'package.json');
  const pkg: unknown = JSON.parse(await readFile(pkgFile, 'utf8'));
  const schema = Type.Object({ bin: Type.Union([Type.String(), Type.Object({ 'agent-desktop': Type.String() })]) });
  if (!Check(schema, pkg)) throw new Error('agent_desktop_package_invalid');
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin['agent-desktop'];
  const entry = path.resolve(path.dirname(pkgFile), bin);
  if (!entry.startsWith(path.dirname(pkgFile) + path.sep)) throw new Error('agent_desktop_entry_invalid');
  return { command: process.execPath, args: [entry, 'mcp', '--headed'] };
}
const ps = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const unit = (value: string) => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"';
export function startupSpec(directory: string, platform = process.platform, node = process.execPath) {
  const client = path.join(directory, 'client.cjs');
  const suffix = createHash('sha256').update(directory).digest('hex').slice(0, 12);
  const name = 'cs-agent-device-' + suffix;
  if (/[\r\n]/.test(directory + node)) throw new Error('device_path_invalid');
  if (platform === 'darwin') return { kind: 'launchd' as const, name: 'dev.' + name, file: path.join(os.homedir(), 'Library', 'LaunchAgents', 'dev.' + name + '.plist'),
    content: `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>dev.${name}</string><key>ProgramArguments</key><array>${[node, client, 'run', '--state-dir', directory].map(value => '<string>' + xml(value) + '</string>').join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(path.join(directory, 'service.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(directory, 'service.log'))}</string></dict></plist>` };
  if (platform === 'linux') return { kind: 'systemd' as const, name: name + '.service', file: path.join(os.homedir(), '.config', 'systemd', 'user', name + '.service'),
    content: `[Unit]\nDescription=cs-agent device MCP\nAfter=network-online.target\n[Service]\nExecStart=${[node, client, 'run', '--state-dir', directory].map(unit).join(' ')}\nRestart=on-failure\nRestartSec=10\n[Install]\nWantedBy=default.target\n` };
  if (platform !== 'win32') throw new Error('device_platform_unsupported');
  // VBScript 仅负责隐藏控制台并等待 Node，计划任务仍以当前交互用户、普通权限运行。
  const argumentsString = [node, client, 'run', '--state-dir', directory].map(value => '"' + value + '"').join(' ');
  return { kind: 'task' as const, name, file: path.join(directory, 'start.vbs'), content: `Set shell = CreateObject("WScript.Shell")\r\nWScript.Quit shell.Run("${argumentsString.replaceAll('"', '""')}", 0, True)\r\n` };
}
export async function installStartup(directory: string, source: string) {
  const destination = path.join(directory, 'client.cjs');
  if (path.resolve(source) !== destination) await copyFile(source, destination);
  const spec = startupSpec(directory);
  await mkdir(path.dirname(spec.file), { recursive: true });
  await writeFile(spec.file, spec.kind === 'task' ? Buffer.concat([Buffer.from([255, 254]), Buffer.from(spec.content, 'utf16le')]) : Buffer.from(spec.content, 'utf8'), { mode: 0o600 });
  if (spec.kind === 'launchd') {
    const domain = 'gui/' + os.userInfo().uid;
    await run('/bin/launchctl', ['bootout', domain + '/' + spec.name]).catch(() => {});
    await run('/bin/launchctl', ['bootstrap', domain, spec.file]);
  } else if (spec.kind === 'systemd') {
    await run('systemctl', ['--user', 'daemon-reload']);
    await run('systemctl', ['--user', 'enable', '--now', spec.name]);
  } else {
    const script = `$ErrorActionPreference='Stop';$name=${ps(spec.name)};$user=[Security.Principal.WindowsIdentity]::GetCurrent().Name;if(Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue){Stop-ScheduledTask -TaskName $name};$action=New-ScheduledTaskAction -Execute ($env:SystemRoot+'\\System32\\wscript.exe') -Argument ${ps('"' + spec.file + '"')};$trigger=New-ScheduledTaskTrigger -AtLogOn -User $user;$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited;$settings=New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1);Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null;Start-ScheduledTask -TaskName $name`;
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 30000 });
  }
}
export async function removeStartup(directory: string) {
  const spec = startupSpec(directory);
  if (spec.kind === 'launchd') await run('/bin/launchctl', ['bootout', 'gui/' + os.userInfo().uid + '/' + spec.name]);
  else if (spec.kind === 'systemd') await run('systemctl', ['--user', 'disable', '--now', spec.name]);
  else {
    const script = `$name=${ps(spec.name)};Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue;Unregister-ScheduledTask -TaskName $name -Confirm:$false`;
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
  }
  // 仅移除自启动入口；凭据、收据和持久工作区留在设备上。
  const { unlink } = await import('node:fs/promises');
  await unlink(spec.file);
}

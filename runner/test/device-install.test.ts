import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { startupSpec } from '../src/device-install.ts';
import { saveConfig, loadConfig, protectDirectory } from '../src/device-config.ts';
import { defaultShell } from '../src/device-shell.ts';

test('跨平台自启动在登录用户下运行，路径转义且不携带 Token', () => {
  const directory = path.resolve(os.tmpdir(), '中文 空格 & quotes');
  const mac = startupSpec(directory, 'darwin');
  assert.equal(mac.kind, 'launchd'); assert.match(mac.content, /&amp;/); assert.match(mac.content, /RunAtLoad/);
  const linux = startupSpec(directory, 'linux');
  assert.equal(linux.kind, 'systemd'); assert.match(linux.content, /ExecStart="/);
  const windows = startupSpec(directory, 'win32');
  assert.equal(windows.kind, 'task'); assert.match(windows.content, /, 0, True/);
  for (const spec of [mac, linux, windows]) { assert.doesNotMatch(spec.content, /Bearer|tunnelToken|--token/); assert.match(spec.content, /--state-dir/); }
  assert.throws(() => startupSpec('bad\npath'), /path_invalid/);
});
test('本机配置按 UTF-8 保存，命令能力无需桌面配置', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'device-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await protectDirectory(root);
  const config = { version: 1 as const, enrollment: { id: '11111111-1111-4111-8111-111111111111', name: '我的设备', port: 20000, token: 'a'.repeat(64), tunnelToken: 'test-tunnel-token-abcdefghijklmn', desktopToken: null },
    workdir: root, shell: defaultShell(), cloudflared: path.join(root, 'cloudflared'), desktop: null, pairing: null };
  await saveConfig(root, config); assert.deepEqual(await loadConfig(root), config);
  assert.match(await readFile(path.join(root, 'config.json'), 'utf8'), /我的设备/);
});

test('Windows 隐藏启动入口保留中文和空格参数，不注册真实自启动', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), '设备 启动 & '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'args.json'), spec = startupSpec(root);
  await writeFile(path.join(root, 'client.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(output)},JSON.stringify(process.argv.slice(2)),'utf8');`, 'utf8');
  await writeFile(spec.file, Buffer.concat([Buffer.from([255, 254]), Buffer.from(spec.content, 'utf16le')]));
  await promisify(execFile)(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe'), ['//B', '//Nologo', spec.file], { windowsHide: true, timeout: 10000 });
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), ['run', '--state-dir', root]);
});

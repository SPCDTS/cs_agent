import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DeviceShell, defaultShell } from '../src/device-shell.ts';
import { createDeviceServer } from '../src/device-server.ts';

const quote = (value: string) => "'" + value.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''") + "'";
const cmd = (win: string, unix: string) => process.platform === 'win32' ? win : unix;
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cs-device-'));
  const options = { stateDir: root, workdir: path.join(root, '工作区'), shell: defaultShell(), outputLimit: 1024 };
  const shell = new DeviceShell(options);
  t.after(async () => { await shell.close(); await rm(root, { recursive: true, force: true }); });
  return { root, shell, options };
}
test('本机 Shell 真实执行、保留文件、重试去重并隔离收据', async t => {
  const { shell, options } = await fixture(t), requestId = randomUUID(), file = path.join(options.workdir, 'counter.txt');
  const command = cmd(`Add-Content -LiteralPath ${quote(file)} -Value '中文' -Encoding utf8; Write-Output '完成'`, `printf '中文\\n' >> ${quote(file)}; printf '完成\\n'`);
  const input = { requestId, command, waitMs: 5000 };
  const receipt = await shell.exec('a', input);
  assert.equal(receipt.state, 'succeeded'); assert.match(receipt.stdout, /完成/);
  assert.deepEqual(await shell.exec('a', input), receipt);
  assert.equal((await readFile(file, 'utf8')).split('中文').length, 2);
  assert.throws(() => shell.get('b', requestId), /job_not_found/);
  await assert.rejects(shell.exec('a', { ...input, command: command + '\n' }), /request_id_conflict/);
  const bad = await shell.exec('a', { requestId: randomUUID(), command: 'exit 7', waitMs: 5000 });
  assert.equal(bad.exitCode, 7); assert.equal(bad.state, 'failed');
  const longScript = await shell.exec('a', { requestId: randomUUID(), command: '#'.padEnd(20000, 'x') + '\necho 中文脚本', waitMs: 5000 });
  assert.equal(longScript.state, 'succeeded'); assert.match(longScript.stdout, /中文脚本/);
});
test('长命令可查询取消，输出有界，超时终止', async t => {
  const { shell } = await fixture(t);
  const id = randomUUID();
  assert.equal((await shell.exec('a', { requestId: id, command: cmd('Start-Sleep -Seconds 30', 'sleep 30'), waitMs: 0 })).state, 'running');
  await shell.cancel('a', id);
  for (let i = 0; i < 100 && shell.get('a', id).state === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(shell.get('a', id).state, 'cancelled');
  const output = await shell.exec('a', { requestId: randomUUID(), command: cmd("Write-Output ('x' * 5000)", "printf '%5000s' ''"), waitMs: 5000 });
  assert.equal(output.truncated, true); assert.ok(Buffer.byteLength(output.stdout) <= 1024);
  const timeout = await shell.exec('a', { requestId: randomUUID(), command: cmd('Start-Sleep -Seconds 30', 'sleep 30'), timeoutMs: 1000, waitMs: 5000 });
  assert.equal(timeout.state, 'timed_out');
});
test('重启不重放完成或结果未知的请求', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cs-device-restart-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { stateDir: root, workdir: root, shell: defaultShell() }, id = randomUUID();
  const first = new DeviceShell(options), input = { requestId: id, command: 'exit 0', waitMs: 5000 };
  await first.exec('a', input); await first.close();
  const db = new DatabaseSync(path.join(root, 'shell.sqlite'));
  db.exec("UPDATE shell_jobs SET receipt=json_set(receipt,'$.state','running')"); db.close();
  const second = new DeviceShell(options);
  try { assert.equal((await second.exec('a', input)).state, 'unknown'); } finally { await second.close(); }
});
test('MCP HTTP 默认只有命令能力，鉴权与真实工具调用', async t => {
  const { shell } = await fixture(t), token = 'a'.repeat(64), server = createDeviceServer(shell, token);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token, Origin: 'https://other.test' } })).status, 403);
  const client = new Client({ name: 'test', version: '1' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['device_info', 'shell_exec', 'shell_status', 'shell_cancel']);
  const output = await client.callTool({ name: 'shell_exec', arguments: { requestId: randomUUID(), command: 'echo hello', waitMs: 5000 } });
  assert.equal(output.isError, undefined); assert.match(JSON.stringify(output.structuredContent), /hello/);
});

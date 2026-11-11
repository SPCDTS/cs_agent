import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
async function call(client: Client, request: Parameters<Client['callTool']>[0]) { return CallToolResultSchema.parse(await client.callTool(request)); }
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Jobs } from '../src/jobs.ts';
import { createMcpHttpServer } from '../src/server.ts';
import { parseConfig } from '../src/config.ts';
import { CALLER_META_KEY, type Backend, type Execution, type ServerConfig, type Subject } from '../src/domain.ts';
test('真实官方 SDK HTTP：工具发现、结构化回执、断线续查、身份隔离、参数与认证拒绝', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'windows-mcp-http-')), calls: Execution[] = [];
  let desktopAvailable = false;
  const nativeCalls: Array<{ subject: Subject; name: string; args: Record<string, unknown> }> = [];
  const nativeTool = { name: 'desktop_snapshot', inputSchema: { type: 'object' as const, properties: { app: { type: 'string' } }, additionalProperties: false } };
  const nativeResult = { content: [{ type: 'image' as const, data: 'aGVsbG8=', mimeType: 'image/png' }], structuredContent: { ok: true, snapshot: 'native' } };
  const backend: Backend = {
    async desktopTools() { if (!desktopAvailable) throw new Error('desktop_unavailable'); return { tools: [nativeTool], instructions: '原生指南' }; },
    async desktopCall(_target, subject, name, args) { nativeCalls.push({ subject, name, args }); return nativeResult; },
    async dispatch(e) { calls.push(e); },
    async inspect() { return { state: 'succeeded', result: { exitCode: 0, stdout: '测试通过', stderr: '', truncated: false } }; },
    async stop() { return { state: 'cancelled' }; }, async closeSession() { return true; },
    async screen() { return { frameId: 'frame', width: 1, height: 1, mimeType: 'image/png', data: 'aGVsbG8=' }; },
  };
  const config: ServerConfig = { stateDir: dir, host: '127.0.0.1', port: 7791, principals: [{ id: 'worker', tokenEnv: 'TEST_TOKEN' }], targets: [
    { kind: 'hyperv', id: 'dev', vmId: randomUUID(), credentialPath: 'C:\\credential.xml', guestWorkdir: 'C:\\Work', desktopUser: 'dev', desktopMcp: true },
    { kind: 'wsb', id: 'temp', memoryMb: 2048, idleTimeoutMs: 60000, maxLifetimeMs: 3600000 },
  ] };
  const backends = { hyperv: backend, wsb: backend }, jobs = new Jobs(dir, backends);
  jobs.bindTargets(config.targets);
  const server = createMcpHttpServer(config, jobs, backends, { TEST_TOKEN: 'x'.repeat(64) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const clients: Client[] = [];
  t.after(async () => { await Promise.all(clients.map(c => c.close())); await new Promise<void>(resolve => server.close(() => resolve())); await jobs.shutdown(); await rm(dir, { recursive: true, force: true }); });
  async function connect() {
    const client = new Client({ name: 'test', version: '1' }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer ' + 'x'.repeat(64) } } })); return client;
  }
  const client = await connect();
  const offline = await client.listTools();
  assert.ok(offline.tools.some(tool => tool.name === 'wsb_temp_submit'));
  assert.ok(!offline.tools.some(tool => tool.name === 'vm_dev_desktop_snapshot'));
  desktopAvailable = true;
  const catalog = await client.listTools();
  assert.ok(catalog.tools.some(tool => tool.name === 'wsb_temp_close'));
  assert.ok(catalog.tools.some(tool => tool.name === 'vm_dev_input' && tool.outputSchema));
  assert.match(catalog.tools.find(tool => tool.name === 'wsb_temp_submit')!.description!, /都不持久/);
  assert.ok(!catalog.tools.some(tool => /sandbox_|acquire|register/.test(tool.name)));
  assert.deepEqual(catalog.tools.find(tool => tool.name === 'vm_dev_desktop_snapshot')?.inputSchema, nativeTool.inputSchema);
  const nativeMeta = { [CALLER_META_KEY]: { scope: 'c'.repeat(64) } };
  assert.deepEqual(await call(client, { name: 'vm_dev_desktop_snapshot', arguments: { app: 'probe' }, _meta: nativeMeta }), nativeResult);
  assert.deepEqual(nativeCalls, [{ subject: { principal: 'worker', scope: 'c'.repeat(64) }, name: 'desktop_snapshot', args: { app: 'probe' } }]);
  assert.equal((await call(client, { name: 'vm_dev_desktop_snapshot', arguments: {}, _meta: { [CALLER_META_KEY]: { scope: '' } } })).isError, true);
  assert.equal(nativeCalls.length, 1);
  const id = randomUUID(), meta = { [CALLER_META_KEY]: { scope: 'a'.repeat(64) } };
  const submitted = await call(client, { name: 'wsb_temp_submit', arguments: { requestId: id, script: 'Write-Output 测试' }, _meta: meta });
  assert.equal(submitted.isError, undefined); assert.equal(submitted.structuredContent?.state, 'queued');
  const session = submitted.structuredContent?.sessionId; assert.equal(typeof session, 'string');
  await client.close(); await jobs.tick(); assert.equal(calls.length, 1);
  const second = await connect();
  const queried = await call(second, { name: 'wsb_temp_job_get', arguments: { requestId: id }, _meta: meta });
  assert.equal(queried.structuredContent?.state, 'succeeded'); assert.equal(queried.structuredContent?.sessionId, session);
  const replay = await call(second, { name: 'wsb_temp_submit', arguments: { requestId: id, script: 'Write-Output 测试' }, _meta: meta });
  assert.equal(replay.structuredContent?.jobId, submitted.structuredContent?.jobId); assert.equal(calls.length, 1);
  const foreign = await call(second, { name: 'wsb_temp_job_get', arguments: { requestId: id }, _meta: { [CALLER_META_KEY]: { scope: 'b'.repeat(64) } } });
  assert.equal(foreign.isError, true);
  const forged = await call(second, { name: 'wsb_temp_job_get', arguments: { requestId: id, scope: 'a'.repeat(64) } });
  assert.equal(forged.isError, true);
  const changed = await call(second, { name: 'wsb_temp_submit', arguments: { requestId: id, script: 'other' }, _meta: meta });
  assert.equal(changed.isError, true);
  const invalidMeta = await call(second, { name: 'wsb_temp_job_get', arguments: { requestId: id }, _meta: { [CALLER_META_KEY]: { scope: '' } } });
  assert.equal(invalidMeta.isError, true);
  const shot = await call(second, { name: 'vm_dev_screen', arguments: {}, _meta: meta });
  assert.equal(shot.structuredContent?.frameId, 'frame'); assert.equal((shot.content as Array<{type:string}>)[0]?.type, 'image');
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  const headers = { Authorization: 'Bearer ' + 'x'.repeat(64), 'Content-Type': 'application/json' };
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://attacker.example' }, body: '{}' })).status, 403);
  const badHost = await new Promise<number>(resolve => { const req = request(url, { method: 'POST', headers: { ...headers, Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode!); }); req.end('{}'); });
  assert.equal(badHost, 403);
  assert.equal((await fetch(url, { headers })).status, 405);
  assert.equal((await fetch(url, { method: 'POST', headers, body: '{' })).status, 400);
});
test('配置只允许明确的持久 VM/临时 WSB，拒绝旧连接器配置与环境 ID 混淆', () => {
  const valid = { stateDir: path.resolve('state'), host: '127.0.0.1', port: 7791, principals: [{ id: 'owner', tokenEnv: 'TOKEN' }], targets: [{ kind: 'wsb', id: 'temp', memoryMb: 2048, idleTimeoutMs: 60000, maxLifetimeMs: 60000 }] };
  assert.equal(parseConfig(valid).targets[0]?.kind, 'wsb');
  assert.throws(() => parseConfig({ ...valid, dataDir: 'D:\\sandbox-data' }), /invalid_windows_mcp_config/);
  assert.throws(() => parseConfig({ ...valid, host: '0.0.0.0' }), /invalid_windows_mcp_config/);
  assert.throws(() => parseConfig({ ...valid, targets: [...valid.targets, ...valid.targets] }), /duplicate_id/);
  const vm = { kind: 'hyperv', id: 'dev', vmId: randomUUID(), credentialPath: path.resolve('secret.xml'), guestWorkdir: 'C:\\AgentWork' };
  assert.equal(parseConfig({ ...valid, targets: [vm] }).targets[0]?.kind, 'hyperv');
  assert.throws(() => parseConfig({ ...valid, targets: [{ ...vm, desktopMcp: true }] }), /desktop_user_required/);
});

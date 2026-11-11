import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Check } from 'typebox/value';
import { Type } from 'typebox';
import { createDesktopMcpGuest } from '../src/desktop-mcp-guest.ts';
import type { DesktopMcpOperation, DesktopMcpSettings } from '../src/desktop-mcp-protocol.ts';
import { createHypervBackend } from '../src/hyperv.ts';
import type { HypervTarget } from '../src/domain.ts';

test('交互桥接使用真实 SDK stdio：保留图片与 schema、隔离引用、拒绝锁屏、断线不重放', { timeout: 30_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-mcp-'));
  const marker = join(dir, 'calls.txt');
  const pipe = process.platform === 'win32' ? '\\\\.\\pipe\\cs-agent-test-' + randomUUID() : join(dir, 'socket');
  const fixture = fileURLToPath(new URL('./fixtures/desktop-fixture.ts', import.meta.url));
  const settings: DesktopMcpSettings = { pipeName: 'cs-agent-desktop-' + 'a'.repeat(32), token: 'a'.repeat(64), desktopSid: 'S-1-5-21', command: process.execPath, args: [fixture, marker], cwd: dirname(fixture), scopeArgument: '--session' };
  let stamp = 'desktop-session-1', locked = false, guards = 0;
  const bridge = createDesktopMcpGuest(settings, async () => { guards++; if (locked) throw new Error('desktop_unavailable'); return stamp; }, { pipe });
  await bridge.listen();
  t.after(async () => { await bridge.close(); await rm(dir, { recursive: true, force: true }); });
  function rpc(operation: DesktopMcpOperation, options: { scope?: string; token?: string; timeout?: number } = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(pipe); let output = '';
      socket.on('error', reject); socket.on('data', chunk => { output += chunk.toString(); });
      socket.on('end', () => { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } });
      socket.on('connect', () => socket.write(JSON.stringify({ token: options.token ?? settings.token, scope: options.scope ?? 'a'.repeat(64), deadline: Date.now() + (options.timeout ?? 10_000), operation }) + '\n'));
    });
  }
  function payload(raw: unknown): unknown { assert.ok(Check(Type.Object({ ok: Type.Literal(true), result: Type.Unknown() }), raw)); return raw.result; }
  const catalog = ListToolsResultSchema.parse(payload(await rpc({ kind: 'list' })));
  assert.equal(catalog.tools[0]?.inputSchema.additionalProperties, false);
  assert.equal(catalog.tools[0]?.name, 'desktop_fixture');
  const call = (mode = '', scope?: string, timeout?: number) => rpc({ kind: 'call', name: 'desktop_fixture', arguments: { mode } }, { scope, timeout });
  const first = CallToolResultSchema.parse(payload(await call()));
  assert.deepEqual(first.content, [{ type: 'text', text: '原生文本' }, { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }]);
  assert.equal(first.structuredContent?.calls, 1);
  const second = CallToolResultSchema.parse(payload(await call()));
  assert.equal(second.structuredContent?.calls, 2);
  assert.equal(second.structuredContent?.namespace, first.structuredContent?.namespace);
  const foreign = CallToolResultSchema.parse(payload(await call('', 'b'.repeat(64))));
  assert.equal(foreign.structuredContent?.calls, 1);
  assert.notEqual(foreign.structuredContent?.namespace, first.structuredContent?.namespace);
  const before = guards;
  assert.deepEqual(await rpc({ kind: 'list' }, { token: 'x'.repeat(64) }), { ok: false, error: 'desktop_mcp_denied' });
  assert.equal(guards, before);
  locked = true;
  assert.deepEqual(await call(), { ok: false, error: 'desktop_unavailable' });
  locked = false;
  assert.equal(CallToolResultSchema.parse(payload(await call())).structuredContent?.calls, 3);
  stamp = 'desktop-session-2';
  const changed = CallToolResultSchema.parse(payload(await call()));
  assert.notEqual(changed.structuredContent?.namespace, first.structuredContent?.namespace);
  assert.equal(changed.structuredContent?.calls, 1);
  const error = CallToolResultSchema.parse(payload(await call('reject')));
  assert.equal(error.isError, true); assert.deepEqual(error.structuredContent, { disposition: { retry: 'unsafe' } });
  assert.deepEqual(await call('crash'), { ok: false, error: 'desktop_mcp_outcome_unknown' });
  assert.equal(await readFile(marker, 'utf8'), 'invoked\n');
  await call();
  const slow = call('slow', undefined, 1500);
  const expired = call('crash', undefined, 300);
  assert.deepEqual(await slow, { ok: false, error: 'desktop_mcp_outcome_unknown' });
  assert.deepEqual(await expired, { ok: false, error: 'desktop_mcp_expired' });
  assert.equal(await readFile(marker, 'utf8'), 'invoked\n');
});

test('Hyper-V 原生 MCP 作用域绑定认证身份与 VM；丢失结果不重复调用', async () => {
  const target: HypervTarget = { kind: 'hyperv', id: 'dev', vmId: randomUUID(), credentialPath: 'C:\\credential.xml', guestWorkdir: 'C:\\Work', desktopUser: 'agent', desktopMcp: true };
  const scopes: string[] = [];
  let calls = 0, lost = false;
  const backend = createHypervBackend('unused', async (_target, request) => {
    assert.equal(request.action, 'mcp'); if (request.action !== 'mcp') throw Error('unexpected');
    scopes.push(request.scope); calls++;
    if (lost) throw Error('transport closed');
    if (request.operation.kind === 'list') return { ok: true, result: { tools: [], instructions: '原生指南' } };
    return { ok: true, result: { content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }], structuredContent: { frame: 'native' } } };
  });
  assert.ok(backend.desktopTools); assert.ok(backend.desktopCall);
  const owner = { principal: 'owner', scope: 'a'.repeat(64) };
  assert.deepEqual(await backend.desktopTools(target, owner), { tools: [], instructions: '原生指南' });
  const result = await backend.desktopCall(target, owner, 'desktop_screenshot', {});
  assert.equal(result.content[0]?.type, 'image'); assert.equal(scopes[0], scopes[1]);
  await backend.desktopCall(target, { ...owner, principal: 'other' }, 'desktop_screenshot', {});
  await backend.desktopCall({ ...target, vmId: randomUUID() }, owner, 'desktop_screenshot', {});
  assert.equal(new Set(scopes).size, 3); assert.match(scopes[0]!, /^[a-f0-9]{64}$/);
  lost = true;
  await assert.rejects(backend.desktopCall(target, owner, 'desktop_click', {}), /desktop_mcp_outcome_unknown/);
  assert.equal(calls, 5);
  await assert.rejects(backend.desktopCall({ ...target, desktopMcp: false }, owner, 'desktop_click', {}), /desktop_mcp_unavailable/);
  assert.equal(calls, 5);
});

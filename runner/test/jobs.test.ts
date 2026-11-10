import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Jobs } from '../src/jobs.ts';
import type { Backend, Execution, ExecutionStatus, Target } from '../src/domain.ts';
const subject = { principal: 'test', scope: 'a'.repeat(64) };
const vm: Target = { kind: 'hyperv', id: 'dev', vmId: randomUUID(), credentialPath: 'C:\\secret.xml', guestWorkdir: 'C:\\Work' };
const wsb: Target = { kind: 'wsb', id: 'temp', memoryMb: 2048, idleTimeoutMs: 60000, maxLifetimeMs: 3600000 };
const command = { kind: 'powershell' as const, script: 'Get-Date', timeoutMs: 120000 };
const success: ExecutionStatus = { state: 'succeeded', result: { exitCode: 0, stdout: 'ok', stderr: '', truncated: false } };
function fake() {
  const calls: Execution[] = [], stopped: string[] = [], closed: string[] = [], states = new Map<string, ExecutionStatus>();
  let closeConfirmed = true;
  const backend: Backend = {
    async dispatch(e) { calls.push(e); states.set(e.id, { state: 'running' }); },
    async inspect(e) { return states.get(e.id) ?? { state: 'unknown', error: 'missing_evidence' }; },
    async stop(e) { stopped.push(e.id); return states.get(e.id)?.state === 'unknown' ? { state: 'unknown', error: 'stop_not_confirmed' } : { state: 'cancelled' }; },
    async closeSession(id) { closed.push(id); if (closeConfirmed) for (const e of calls) if (e.sessionId === id && ['unknown', 'running'].includes(states.get(e.id)?.state ?? 'unknown')) states.set(e.id, { state: 'cancelled' }); return closeConfirmed; },
  };
  return { backend, calls, stopped, closed, states, setClose(value: boolean) { closeConfirmed = value; } };
}
async function fixture(t: TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'windows-mcp-jobs-')); const f = fake(); let now = 1000;
  let jobs = new Jobs(dir, { hyperv: f.backend, wsb: f.backend }, () => now);
  t.after(async () => { await jobs.shutdown(); await rm(dir, { recursive: true, force: true }); });
  return { f, get jobs() { return jobs; }, time(value: number) { now = value; }, async restart() { await jobs.shutdown(); jobs = new Jobs(dir, { hyperv: f.backend, wsb: f.backend }, () => now); } };
}
test('持久请求去重、冲突与重启只查证据，不重新执行', async t => {
  const x = await fixture(t), id = randomUUID();
  const first = x.jobs.submit(subject, vm, id, command); await x.jobs.tick();
  assert.equal(x.f.calls.length, 1);
  assert.equal(x.jobs.submit(subject, vm, id, command).jobId, first.jobId);
  assert.throws(() => x.jobs.submit(subject, vm, id, { ...command, script: 'Remove-Item x' }), /request_id_conflict/);
  await x.restart(); await x.jobs.tick(); assert.equal(x.f.calls.length, 1);
  x.f.states.set(first.jobId, success); await x.jobs.tick();
  assert.equal(x.jobs.get(subject, vm, id).state, 'succeeded');
  assert.equal(x.jobs.submit(subject, vm, id, command).state, 'succeeded');
});
test('WSB 首提交丢回包可找回 session，去重先于容量检查，关闭后仍保留收据', async t => {
  const x = await fixture(t), id = randomUUID();
  const first = x.jobs.submit(subject, wsb, id, command); assert.ok(first.sessionId);
  assert.equal(x.jobs.submit(subject, wsb, id, command).sessionId, first.sessionId);
  assert.equal(x.jobs.get(subject, wsb, id).sessionId, first.sessionId);
  assert.throws(() => x.jobs.submit(subject, wsb, randomUUID(), command), /wsb_busy/);
  await x.jobs.tick(); x.f.states.set(first.jobId, success); await x.jobs.tick();
  const next = x.jobs.submit(subject, wsb, randomUUID(), command, first.sessionId); await x.jobs.tick();
  assert.equal(x.f.calls[1]?.sessionId, first.sessionId);
  assert.equal(x.jobs.close(subject, wsb, first.sessionId).state, 'closing');
  await x.jobs.tick(); assert.equal(x.jobs.close(subject, wsb, first.sessionId).state, 'closed');
  assert.equal(x.jobs.get(subject, wsb, next.requestId).state, 'cancelled');
  assert.equal(x.jobs.submit(subject, wsb, id, command).sessionId, first.sessionId);
});
test('跨 principal/scope/target 不泄露或接管任务和 session', async t => {
  const x = await fixture(t), id = randomUUID(), first = x.jobs.submit(subject, wsb, id, command);
  for (const other of [{ ...subject, scope: 'b'.repeat(64) }, { ...subject, principal: 'other' }]) {
    assert.throws(() => x.jobs.get(other, wsb, id), /job_not_found/);
    assert.throws(() => x.jobs.cancel(other, wsb, id), /job_not_found/);
    assert.throws(() => x.jobs.close(other, wsb, first.sessionId!), /session_not_found/);
    assert.throws(() => x.jobs.submit(other, wsb, randomUUID(), command, first.sessionId), /session_unavailable/);
  }
  assert.throws(() => x.jobs.get(subject, vm, id), /job_not_found/);
});
test('unknown 保留执行槽位，取消必须得到真实停止证据', async t => {
  const x = await fixture(t), id = randomUUID();
  const first = x.jobs.submit(subject, wsb, id, command); await x.jobs.tick();
  x.f.states.set(first.jobId, { state: 'unknown', error: 'missing_receipt' }); await x.jobs.tick();
  assert.equal(x.jobs.get(subject, wsb, id).state, 'unknown');
  const second = x.jobs.submit(subject, wsb, randomUUID(), command, first.sessionId); await x.jobs.tick();
  assert.equal(x.f.calls.length, 1); assert.equal(x.jobs.get(subject, wsb, second.requestId).state, 'queued');
  x.f.setClose(false); x.jobs.cancel(subject, wsb, id); await x.jobs.tick();
  assert.equal(x.jobs.get(subject, wsb, id).state, 'cancelling');
  assert.throws(() => x.jobs.submit(subject, wsb, randomUUID(), command), /wsb_busy/);
  assert.throws(() => x.jobs.submit(subject, wsb, randomUUID(), command, first.sessionId), /session_unavailable/);
  x.f.setClose(true); await x.jobs.tick(); assert.equal(x.jobs.get(subject, wsb, id).state, 'cancelled');
  assert.equal(x.f.calls.length, 1);
});
test('VM FIFO 与 deadline：排队过期不执行，活跃任务只调用 backend stop', async t => {
  const x = await fixture(t), first = x.jobs.submit(subject, vm, randomUUID(), command), second = x.jobs.submit(subject, vm, randomUUID(), { ...command, timeoutMs: 1000 });
  await x.jobs.tick(); assert.equal(x.f.calls.length, 1);
  x.time(122000); await x.jobs.tick(); await x.jobs.tick();
  assert.equal(x.jobs.get(subject, vm, first.requestId).state, 'cancelled');
  assert.equal(x.jobs.get(subject, vm, second.requestId).state, 'cancelled');
  assert.equal(x.f.calls.length, 1); assert.deepEqual(x.f.stopped, [first.jobId]); assert.deepEqual(x.f.closed, []);
});
test('WSB 空闲 TTL 关闭实例；服务重启后仍处理同一 session', async t => {
  const x = await fixture(t), first = x.jobs.submit(subject, wsb, randomUUID(), command); await x.jobs.tick();
  x.f.states.set(first.jobId, success); await x.jobs.tick(); await x.restart();
  x.time(62000); await x.jobs.tick(); assert.deepEqual(x.f.closed, [first.sessionId]);
  assert.equal(x.jobs.close(subject, wsb, first.sessionId!).state, 'closed');
});
test('target id 不可复用到不同 VM，避免同名工具指向另一工作区', async t => {
  const x = await fixture(t); x.jobs.bindTargets([vm, wsb]);
  assert.throws(() => x.jobs.bindTargets([{ ...vm, vmId: randomUUID() }]), /target_id_reused/);
});
test('派发中异常只进入 unknown，轮询和重启不再次 dispatch', async t => {
  const x = await fixture(t); x.f.backend.dispatch = async e => { x.f.calls.push(e); throw new Error('connection_lost'); };
  const first = x.jobs.submit(subject, vm, randomUUID(), command); await x.jobs.tick();
  assert.equal(x.jobs.get(subject, vm, first.requestId).state, 'unknown');
  await x.restart(); await x.jobs.tick(); assert.equal(x.f.calls.length, 1);
});

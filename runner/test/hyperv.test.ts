
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Command, Execution, HypervTarget } from '../src/domain.ts';
import { createHypervBackend, type HypervBridge } from '../src/hyperv.ts';

const vm: HypervTarget = {
  kind: 'hyperv', id: 'vm', vmId: randomUUID(), credentialPath: 'C:\\local\\credential.clixml',
  guestWorkdir: 'C:\\workspace',
};
const subject = { principal: 'owner', scope: 'task' };
const shell: Command = { kind: 'powershell', script: 'Write-Output "你好"', timeoutMs: 30_000 };
const execution = (command: Command = shell): Execution => ({
  id: randomUUID(), requestId: randomUUID(), target: vm, subject, deadline: Date.now() + 30_000, command,
});

async function directory(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'cs-agent-hyperv-'));
  t.after(() => rm(path, { recursive: true, force: true, maxRetries: 3 }));
  return path;
}

test('Hyper-V 传输丢失后只对同一个来宾 ID 查询或取消', async (t) => {
  const path = await directory(t);
  const calls: Array<{ action: string; id?: string }> = [];
  const bridge: HypervBridge = async (target, request) => {
    assert.equal(target.vmId, vm.vmId);
    calls.push({ action: request.action, id: 'id' in request ? request.id : undefined });
    if (request.action === 'dispatch') {
      assert.deepEqual(request.command, shell);
      throw new Error('lost reply');
    }
    if (request.action === 'stop') return { state: 'cancelled' };
    return { state: 'unknown', error: 'guest_receipt_missing' };
  };
  const job = execution();
  await assert.rejects(createHypervBackend(path, bridge).dispatch(job), /lost reply/);
  const restarted = createHypervBackend(path, bridge);
  await restarted.dispatch(job);
  assert.equal((await restarted.inspect(job)).state, 'unknown');
  assert.equal((await restarted.stop(job)).state, 'cancelled');
  assert.deepEqual(calls, ['dispatch', 'inspect', 'stop'].map(action => ({ action, id: job.id })));
});

test('Hyper-V 状态只 probe，报告版本或不可用而不派发命令', async t => {
  const path = await directory(t), actions: string[] = [];
  const helperVersion = 'sha256:' + 'a'.repeat(64);
  let reply: unknown = { ready: true, protocolVersion: 1, helperVersion };
  const backend = createHypervBackend(path, async (_target, request) => { actions.push(request.action); if (reply instanceof Error) throw reply; return reply; });
  assert.deepEqual(await backend.probe?.(vm), { state: 'ready', protocolVersion: 1, helperVersion });
  reply = { ready: true };
  assert.deepEqual(await backend.probe?.(vm), { state: 'unknown', error: 'hyperv_helper_version_unavailable' });
  reply = new Error('credentials or transport failure');
  assert.deepEqual(await backend.probe?.(vm), { state: 'unavailable', error: 'hyperv_probe_unavailable' });
  assert.deepEqual(actions, ['probe', 'probe', 'probe']);
});

test('Hyper-V 来宾原生助手记录输出、取消整个 Job Object', {
  skip: process.platform !== 'win32' || process.env.CS_AGENT_TEST_HYPERV_NATIVE !== '1', timeout: 30_000,
}, async (t) => {
  const path = await directory(t);
  const sources = fileURLToPath(new URL('../native/hyperv/', import.meta.url));
  const compiler = join(process.env.SystemRoot ?? 'C:/Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  try { await stat(compiler); } catch { t.skip('Windows .NET Framework C# 编译器不可用'); return; }
  const helper = join(path, 'Helper.exe');
  await promisify(execFile)(compiler, [
    '/nologo', '/target:winexe', '/platform:anycpu', '/out:' + helper, '/r:System.Web.Extensions.dll',
    ...['Helper.cs', 'Job.cs'].map(name => join(sources, name)),
  ], { windowsHide: true });
  await copyFile(join(sources, 'launch.ps1'), join(path, 'launch.ps1'));
  await copyFile(join(sources, 'bridge.ps1'), join(path, 'bridge.ps1'));
  const directBridge = [
    "$ErrorActionPreference = 'Stop'",
    '$root = $env:CS_AGENT_TEST_HYPERV_DIR',
    '$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    '$setup = @{ version = 1; bridgeSid = $sid; workdir = $root } | ConvertTo-Json -Compress',
    '[IO.File]::WriteAllText((Join-Path $root "settings.json"), $setup)',
    '$id = [Guid]::NewGuid().ToString("D")',
    '$source = [IO.File]::ReadAllText((Join-Path $root "bridge.ps1"))',
    'function Invoke-Fixture($request) {',
    '  $json = @{ workdir = $root; request = $request } | ConvertTo-Json -Depth 5 -Compress',
    '  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))',
    '  & ([ScriptBlock]::Create($source)) $encoded $root',
    '}',
    'class FixtureFolder { [object] GetTask([string]$name) { return @{ Enabled = $true } } }',
    'class FixtureScheduler { [void] Connect() {} [object] GetFolder([string]$name) { return [FixtureFolder]::new() } }',
    'function New-Object { param([string]$ComObject) return [FixtureScheduler]::new() }',
    '$probe = (Invoke-Fixture @{ action = "probe" }) | ConvertFrom-Json',
    'if (-not $probe.ready -or $probe.protocolVersion -ne 1 -or $probe.helperVersion -cnotmatch "^sha256:[a-f0-9]{64}$") { throw "fixture_probe_invalid" }',
    'Remove-Item Function:/New-Object',
    'Invoke-Fixture @{ action = "stop"; id = $id }',
    'Invoke-Fixture @{ action = "dispatch"; id = $id; deadline = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 20000; command = @{ kind = "powershell"; script = "throw 1" } }',
    'Invoke-Fixture @{ action = "inspect"; id = $id }',
    'function New-Object { param([string]$ComObject) throw "fixture_skip_task_scheduler" }',
    '$parent = Split-Path -Parent $root',
    'foreach ($test in @(',
    '  @{ cwd = $parent; expected = $parent },',
    '  @{ cwd = "..\\another"; expected = Join-Path $parent "another" },',
    '  @{ cwd = "\\\\guest\\share\\workspace"; expected = "\\\\guest\\share\\workspace" }',
    ')) {',
    '  $id = [Guid]::NewGuid().ToString("D")',
    '  try {',
    '    Invoke-Fixture @{ action = "dispatch"; id = $id; deadline = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 20000; command = @{ kind = "powershell"; script = "throw 1"; cwd = $test.cwd } }',
    '    throw "fixture_expected_task_scheduler_call"',
    '  } catch { if ($_.Exception.Message -ne "fixture_skip_task_scheduler") { throw } }',
    '  $request = [IO.File]::ReadAllText((Join-Path $root ("jobs\\{0}\\request.json" -f $id))) | ConvertFrom-Json',
    '  if ($request.cwd -cne $test.expected) { throw "fixture_unexpected_guest_cwd" }',
    '}',
  ].join('\n');
  const powershell = join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await promisify(execFile)(powershell, [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(directBridge, 'utf16le').toString('base64'),
  ], { windowsHide: true, env: { ...process.env, CS_AGENT_TEST_HYPERV_DIR: path } });
  assert.deepEqual(stdout.trim().split(/\r?\n/).map(line => JSON.parse(line)), [
    { state: 'cancelled' }, { state: 'cancelled' }, { state: 'cancelled' },
  ]);

  async function run(kind: 'shell', command: object, script?: string) {
    const id = randomUUID();
    const jobPath = join(path, 'jobs', id);
    await mkdir(jobPath, { recursive: true });
    await writeFile(join(jobPath, 'request.json'), JSON.stringify({ cwd: path, deadline: Date.now() + 20_000, ...command }));
    if (script !== undefined) await writeFile(join(jobPath, 'script.ps1'), '\uFEFF' + script);
    const child = spawn(helper, [kind, id], { windowsHide: true, stdio: 'ignore' });
    const finished = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error('来宾助手退出码 ' + code)));
    });
    t.after(() => child.kill());
    return {
      jobPath,
      result: async (): Promise<unknown> => {
        await finished;
        return JSON.parse(await readFile(join(jobPath, 'terminal.json'), 'utf8'));
      },
    };
  }

  const output = await run('shell', { kind: 'powershell' }, 'Write-Output "你好"; [Console]::Error.WriteLine("警告"); exit 7');
  assert.deepEqual(await output.result(), {
    state: 'succeeded', result: { exitCode: 7, stdout: '你好\r\n', stderr: '警告\r\n', truncated: false },
  });
  const limited = await run('shell', { kind: 'powershell' }, '[Console]::Write("a" * 40000)');
  assert.deepEqual(await limited.result(), {
    state: 'succeeded', result: { exitCode: 0, stdout: 'a'.repeat(32768), stderr: '', truncated: true },
  });

  const childStarted = join(path, 'child-pid.txt');
  const started = await run('shell', { kind: 'powershell' }, [
    '$child = Start-Process -FilePath "$PSHOME\\powershell.exe" -ArgumentList "-NoProfile -Command Start-Sleep -Seconds 60" -PassThru -WindowStyle Hidden',
    '[IO.File]::WriteAllText((Join-Path $PWD "child-pid.txt"), [string]$child.Id)',
    'Start-Sleep -Seconds 60',
  ].join('\r\n'));
  let pid = '';
  for (let attempt = 0; attempt < 100 && !pid; attempt++) {
    try { pid = await readFile(childStarted, 'utf8'); } catch { await setTimeout(50); }
  }
  assert.match(pid, /^[1-9][0-9]*$/);
  process.kill(Number(pid), 0);
  await writeFile(join(started.jobPath, 'cancel'), '');
  assert.deepEqual(await started.result(), { state: 'cancelled' });
  assert.throws(() => process.kill(Number(pid), 0), /ESRCH/);

  const expired = await run('shell', { kind: 'powershell', deadline: Date.now() - 1 }, 'throw "expired script executed"');
  assert.deepEqual(await expired.result(), { state: 'cancelled' });


});

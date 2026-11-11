import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import type { Backend, Command, Execution, ExecutionStatus, HypervTarget } from './domain.ts';

const maxReplyBytes = 12 * 1024 * 1024;
const unknown: ExecutionStatus = { state: 'unknown', error: 'Hyper-V 执行收据不可用' };
const executionResult = Type.Union([
  Type.Object({ state: Type.Literal('running') }),
  Type.Object({ state: Type.Literal('cancelled') }),
  Type.Object({ state: Type.Literal('failed'), error: Type.String({ maxLength: 200 }) }),
  Type.Object({ state: Type.Literal('unknown'), error: Type.String({ maxLength: 200 }) }),
  Type.Object({ state: Type.Literal('succeeded'), result: Type.Object({
    exitCode: Type.Integer(), stdout: Type.String({ maxLength: 65_536 }),
    stderr: Type.String({ maxLength: 65_536 }), truncated: Type.Boolean(),
  }) }),
]);
const probeResult = Type.Object({ ready: Type.Literal(true) });

type BridgeRequest =
  | { action: 'probe' }
  | { action: 'inspect' | 'stop'; id: string }
  | { action: 'dispatch'; id: string; deadline: number; command: Command };

export type HypervBridge = (target: HypervTarget, request: BridgeRequest) => Promise<unknown>;

const callPowerShell: HypervBridge = (target, request) => new Promise((resolve, reject) => {
  const error = () => new Error('Hyper-V PowerShell Direct 连接不可用');
  const launcher = fileURLToPath(new URL('../native/hyperv/host.ps1', import.meta.url));
  const powershell = join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(powershell, ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcher], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const timer = setTimeout(() => {
    child.kill();
    reject(error());
  }, 15_000);
  const output: Buffer[] = [];
  let size = 0;
  child.stdout.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > maxReplyBytes) {
      child.kill();
      reject(error());
      return;
    }
    output.push(chunk);
  });
  child.stdin.on('error', () => reject(error()));
  child.on('error', () => {
    clearTimeout(timer);
    reject(error());
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (code !== 0 || size > maxReplyBytes) {
      reject(error());
      return;
    }
    try {
      resolve(JSON.parse(Buffer.concat(output).toString('utf8')));
    } catch {
      reject(error());
    }
  });
  child.stdin.end(Buffer.from(JSON.stringify({
    vmId: target.vmId, credentialPath: target.credentialPath,
    guestWorkdir: target.guestWorkdir, request,
  }), 'utf8').toString('base64'));
});

export async function probeHypervTarget(target: HypervTarget): Promise<{ ready: true }> {
  const result = await callPowerShell(target, { action: 'probe' });
  if (!Check(probeResult, result)) throw new Error('Hyper-V 来宾助手未安装或配置不匹配');
  return result;
}

export function createHypervBackend(stateDir: string, bridge: HypervBridge = callPowerShell): Backend {
  const intents = join(stateDir, 'hyperv');
  function targetOf(execution: Execution): HypervTarget {
    if (execution.target.kind !== 'hyperv') throw new Error('Hyper-V 后端收到其他执行目标');
    return execution.target;
  }

  function receipt(execution: Execution) {
    if (!/^[a-f\d-]{32,64}$/i.test(execution.id)) throw new Error('Hyper-V 内部执行 ID 无效');
    return join(intents, execution.id);
  }

  async function inspect(execution: Execution, action: 'inspect' | 'stop'): Promise<ExecutionStatus> {
    try {
      const result = await bridge(targetOf(execution), { action, id: execution.id });
      return Check(executionResult, result) ? result : unknown;
    } catch {
      return unknown;
    }
  }

  return {
    async dispatch(execution) {
      const target = targetOf(execution);
      const path = receipt(execution);
      await mkdir(intents, { recursive: true });
      try {
        await writeFile(path, 'intent', { flag: 'wx', flush: true });
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return;
        throw error;
      }

      await bridge(target, {
        action: 'dispatch', id: execution.id, command: execution.command,
        deadline: execution.deadline,
      });
    },
    inspect: (execution) => inspect(execution, 'inspect'),
    stop: (execution) => inspect(execution, 'stop'),
  };
}

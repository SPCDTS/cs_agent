import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import type { DesktopMcpOperation } from './desktop-mcp-protocol.ts';
import type { Backend, Command, Execution, ExecutionStatus, Frame, HypervTarget, Subject } from './domain.ts';

const frameTtlMs = 30_000;
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
const imageResult = Type.Object({
  stamp: Type.String({ minLength: 1, maxLength: 500 }),
  capturedAt: Type.Integer(),
  width: Type.Integer({ minimum: 1, maximum: 8192 }),
  height: Type.Integer({ minimum: 1, maximum: 8192 }),
  data: Type.String({ minLength: 4, maxLength: 8_388_608, pattern: '^[A-Za-z0-9+/]+={0,2}$' }),
});
const probeResult = Type.Object({ desktopConfigured: Type.Boolean() });

interface DesktopFrame extends Omit<Frame, 'data' | 'mimeType' | 'frameId'> {
  stamp: string;
  capturedAt: number;
  expires: number;
  targetId: string;
  vmId: string;
  subject: Subject;
}

type BridgeRequest =
  | { action: 'mcp'; scope: string; deadline: number; operation: DesktopMcpOperation }
  | { action: 'probe' }
  | { action: 'inspect' | 'stop'; id: string }
  | { action: 'screen'; id: string; deadline: number }
  | { action: 'dispatch'; id: string; deadline: number; command: Command;
      frame?: Pick<DesktopFrame, 'stamp' | 'capturedAt'> };

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
  }, request.action === 'mcp' ? (request.operation.kind === 'list' ? 8500 : 55_000) : request.action === 'screen' ? 22_000 : 15_000);
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
    guestWorkdir: target.guestWorkdir, desktopUser: target.desktopUser, request,
  }), 'utf8').toString('base64'));
});

export async function probeHypervTarget(target: HypervTarget): Promise<{ desktopConfigured: boolean }> {
  const result = await callPowerShell(target, { action: 'probe' });
  if (!Check(probeResult, result)) throw new Error('Hyper-V 来宾助手未安装或配置不匹配');
  return result;
}

export function createHypervBackend(stateDir: string, bridge: HypervBridge = callPowerShell): Backend {
  const intents = join(stateDir, 'hyperv');
  const frames = new Map<string, DesktopFrame>();
  function targetOf(execution: Execution): HypervTarget {
    if (execution.target.kind !== 'hyperv') throw new Error('Hyper-V 后端收到其他执行目标');
    return execution.target;
  }

  function consumeFrame(execution: Execution) {
    const { command, subject } = execution;
    if (command.kind !== 'desktop') return;
    const target = targetOf(execution);
    const frame = frames.get(command.frameId);
    if (!frame || frame.expires <= Date.now() ||
        frame.targetId !== target.id || frame.vmId !== target.vmId ||
        frame.subject.principal !== subject.principal || frame.subject.scope !== subject.scope) return;

    const action = command.action;
    if ('x' in action && (!Number.isInteger(action.x) || !Number.isInteger(action.y) ||
        action.x < 0 || action.y < 0 || action.x >= frame.width || action.y >= frame.height)) return;
    frames.delete(command.frameId);
    return { stamp: frame.stamp, capturedAt: frame.capturedAt };
  }

  function receipt(execution: Execution) {
    if (!/^[a-f\d-]{32,64}$/i.test(execution.id)) throw new Error('Hyper-V 内部执行 ID 无效');
    return join(intents, execution.id);
  }

  async function inspect(execution: Execution, action: 'inspect' | 'stop'): Promise<ExecutionStatus> {
    const path = receipt(execution);
    try {
      const saved = await readFile(path, 'utf8');
      if (saved === 'invalid-frame') return { state: 'failed', error: '桌面帧已失效、与当前会话不符或坐标越界' };
    } catch {
      // 来宾可能已收到请求。即使本地收据不可读，仍查询来宾原 ID。
    }

    try {
      const result = await bridge(targetOf(execution), { action, id: execution.id });
      return Check(executionResult, result) ? result : unknown;
    } catch {
      return unknown;
    }
  }

  async function desktop(target: HypervTarget, subject: Subject, operation: DesktopMcpOperation) {
    if (!target.desktopMcp || !target.desktopUser) throw new Error('desktop_mcp_unavailable');
    const scope = createHash('sha256').update(JSON.stringify([subject.principal, subject.scope, target.vmId])).digest('hex');
    let raw: unknown;
    try { raw = await bridge(target, { action: 'mcp', scope, deadline: Date.now() + (operation.kind === 'list' ? 7000 : 45_000), operation }); }
    catch { throw new Error('desktop_mcp_outcome_unknown'); }
    if (Check(Type.Object({ ok: Type.Literal(false), error: Type.String({ pattern: '^desktop_[a-z_]+$' }) }), raw)) throw new Error(raw.error);
    if (!Check(Type.Object({ ok: Type.Literal(true), result: Type.Unknown() }), raw)) throw new Error('desktop_mcp_outcome_unknown');
    return raw.result;
  }

  return {
    async desktopTools(target, subject) {
      const raw = await desktop(target, subject, { kind: 'list' });
      const { tools } = ListToolsResultSchema.parse(raw);
      if (!Check(Type.Object({ instructions: Type.String({ maxLength: 65536 }) }), raw)) throw new Error('desktop_mcp_invalid_catalog');
      return { tools, instructions: raw.instructions };
    },
    async desktopCall(target, subject, name, args) {
      return CallToolResultSchema.parse(await desktop(target, subject, { kind: 'call', name, arguments: args }));
    },
    async dispatch(execution) {
      const target = targetOf(execution);
      const path = receipt(execution);
      const frame = consumeFrame(execution);
      const invalidFrame = execution.command.kind === 'desktop' && !frame;
      await mkdir(intents, { recursive: true });
      try {
        await writeFile(path, invalidFrame ? 'invalid-frame' : 'intent', { flag: 'wx', flush: true });
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return;
        throw error;
      }
      if (invalidFrame) return;

      await bridge(target, {
        action: 'dispatch', id: execution.id, command: execution.command,
        deadline: execution.deadline, frame,
      });
    },
    inspect: (execution) => inspect(execution, 'inspect'),
    stop: (execution) => inspect(execution, 'stop'),
    async screen(target, subject) {
      if (!target.desktopUser) throw new Error('未配置 Hyper-V 来宾桌面账户');
      const now = Date.now();
      for (const [id, frame] of frames) if (frame.expires <= now) frames.delete(id);
      const frameId = randomUUID();
      const raw = await bridge(target, { action: 'screen', id: frameId, deadline: now + 12_000 });
      if (!Check(imageResult, raw)) {
        if (Check(executionResult, raw) && raw.state === 'failed') throw new Error(raw.error);
        throw new Error('Hyper-V 来宾桌面不可用');
      }
      const { width, height, stamp, capturedAt, data } = raw;
      if (frames.size >= 128) {
        const oldest = frames.keys().next();
        if (!oldest.done) frames.delete(oldest.value);
      }
      frames.set(frameId, {
        expires: Date.now() + frameTtlMs, width, height, stamp, capturedAt,
        targetId: target.id, vmId: target.vmId, subject,
      });
      return { frameId, width, height, mimeType: 'image/jpeg', data };
    },
  };
}

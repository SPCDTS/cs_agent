import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
/** Windows MCP 服务和原生后端共享的唯一执行契约。 */
export interface Subject { principal: string; scope: string }
export interface HypervTarget {
  kind: 'hyperv'; id: string; vmId: string; credentialPath: string;
  guestWorkdir: string; desktopUser?: string; desktopMcp?: boolean; instructions?: string;
}
export interface WsbTarget {
  kind: 'wsb'; id: string; memoryMb: number; idleTimeoutMs: number;
  maxLifetimeMs: number; instructions?: string;
}
export type Target = HypervTarget | WsbTarget;
export type DesktopAction =
  | { kind: 'click'; x: number; y: number; button?: 'left' | 'right' }
  | { kind: 'scroll'; x: number; y: number; delta: number }
  | { kind: 'keys'; keys: string[] }
  | { kind: 'text'; text: string };
export type Command =
  | { kind: 'powershell'; script: string; cwd?: string; timeoutMs: number }
  | { kind: 'desktop'; frameId: string; action: DesktopAction; timeoutMs: number };
export interface Execution {
  id: string; requestId: string; subject: Subject; target: Target;
  command: Command; sessionId?: string; deadline: number;
}
export type ExecutionStatus =
  | { state: 'running' }
  | { state: 'succeeded'; result: { exitCode: number; stdout: string; stderr: string; truncated: boolean } }
  | { state: 'failed'; error: string }
  | { state: 'cancelled' }
  | { state: 'unknown'; error: string };
export interface Frame {
  frameId: string; width: number; height: number;
  mimeType: 'image/png' | 'image/jpeg'; data: string;
}
/** 调度器在落盘派发意图后只调用一次 dispatch。重启只 inspect，禁止未知结果重放。
 * 后端必须自己持久化原生执行证据；stop 只有确认停止才返回 cancelled。
 * WSB stop 销毁整个临时 session；Hyper-V stop 只终止本任务进程树。
 */
export interface Backend {
  dispatch(execution: Execution): Promise<void>;
  inspect(execution: Execution): Promise<ExecutionStatus>;
  stop(execution: Execution): Promise<ExecutionStatus>;
  desktopTools?(target: HypervTarget, subject: Subject): Promise<{ tools: Tool[]; instructions: string }>;
  desktopCall?(target: HypervTarget, subject: Subject, name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  closeSession?(sessionId: string): Promise<boolean>;
  screen?(target: HypervTarget, subject: Subject): Promise<Frame>;
}
export interface ServerConfig {
  stateDir: string; host: '127.0.0.1'; port: number;
  principals: Array<{ id: string; tokenEnv: string }>;
  targets: Target[];
}
export const CALLER_META_KEY = 'cs-agent/caller';

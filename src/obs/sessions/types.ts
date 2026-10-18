/** 观测 v2 的统一模型；模型设计来源见 docs/THIRD-PARTY.md。 */
export type SessionRef = { backend: 'codex' | 'pi'; id: string; label: string; scope?: string; status: 'active' | 'archived'; started: number; updated: number; turns: number };
export type TurnIndex = { turn: string; started: number; ended?: number; ticket?: string; preview: string; tools: number; requests: number; usage?: Usage; status: 'ok' | 'failed' | 'running' };
export type Block = { kind: 'user' | 'assistant' | 'thinking' | 'tool_call' | 'tool_result' | 'image' | 'event' | 'compaction' | 'system_change'; ts?: number; callId?: string; text?: string; preview?: string; ref?: ContentRef; meta?: Record<string, unknown> };
export type ContentRef = { session: string; offset: number; length: number; bytes: number };
export type Usage = { input: number; output: number; cached?: number; reasoning?: number; measured: boolean };

/** 送达是票据的补充事实，不替代模型回合的 status。 */
export type ObservedTurn = TurnIndex & { delivery?: { status: string; scope?: string; duration_ms?: number } };
export type SessionFilter = { status?: SessionRef['status']; scope?: string; since?: number; page?: number };
export type IndexProgress = { indexing: boolean; files: number; done: number };
export type BlockFrame = { session: string; turn: string; block: Block };

/** I/O 接口均异步；offset/length 为块正文的虚拟 UTF-8 字节区间，非磁盘任意读入口。 */
export interface SessionAdapter {
  readonly progress?: IndexProgress;
  listSessions(filter?: SessionFilter): Promise<SessionRef[]>;
  turns(id: string): Promise<ObservedTurn[]>;
  blocks(id: string, turn: string): Promise<Block[]>;
  content(ref: ContentRef): Promise<string>;
  subscribe?(id: string, cb: (frame: BlockFrame) => void): () => void;
  refresh?(): Promise<void>;
  close?(): void | Promise<void>;
}

export class SessionError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'SessionError'; }
}

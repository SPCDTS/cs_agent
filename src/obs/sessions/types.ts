/** 观测 v2 的统一模型；模型设计来源见 docs/THIRD-PARTY.md。 */
export type SessionRef = { backend: 'codex' | 'pi'; id: string; label: string; scope?: string; status: 'active' | 'archived'; started: number; updated: number; turns: number };
export type TurnIndex = { turn: string; started: number; ended?: number; /** 关联的宿主回合 trace 键（turn:<id>） */ traceKey?: string; preview: string; tools: number; requests: number; usage?: Usage; status: 'ok' | 'failed' | 'running' };
export type Block = { kind: 'user' | 'assistant' | 'thinking' | 'tool_call' | 'tool_result' | 'image' | 'event' | 'compaction' | 'system_change'; ts?: number; callId?: string; text?: string; preview?: string; ref?: ContentRef; meta?: Record<string, unknown> };
export type ContentRef = { session: string; offset: number; length: number; bytes: number };
export type TraceContentRef = { bundle: string; payload: string; select: string };
export type Usage = { input: number; output: number; cached?: number; reasoning?: number; measured: boolean };

/** 送达是宿主回合的补充事实，不替代模型回合的 status。 */
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
  traceContent?(id: string, ref: TraceContentRef): Promise<string | undefined>;
  subscribe?(id: string, cb: (frame: BlockFrame) => void): () => void;
  refresh?(): Promise<void>;
  close?(): void | Promise<void>;
}

/** Agent 拓扑（/agents）：会话的主 agent 与它派出的子 agent；session 为会话（pi）或线程（codex）id。 */
export type TopologyAgent = {
  session: string; name: string; state: 'running' | 'idle' | 'done' | 'failed' | 'stopped';
  task?: string; result?: string; updated?: number;
};
export type ThreadTopology = { thread: string; backend?: 'pi' | 'codex'; busy: boolean; turnId?: string; session?: string; children: TopologyAgent[] };
export type Activity = { text: string; ts?: number };
export type TopologyNode = TopologyAgent & { activity?: Activity };
export type TopologyRow = Omit<ThreadTopology, 'children'> & { activity?: Activity; children: TopologyNode[] };

export class SessionError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'SessionError'; }
}

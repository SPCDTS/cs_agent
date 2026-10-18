import type { ContentRef, SessionAdapter } from '../sessions/types.js';

export type CategoryKey = 'instructions' | 'tools' | 'history' | 'tool_output' | 'compaction' | 'other';
export type Provenance = 'recorded' | 'reconstructed' | 'estimated' | 'unavailable';
export type ContextAnalysis = {
  backend: 'codex' | 'pi'; session: string; at: { turn: string; phase: 'before' | 'after' }; generatedAt: number;
  window: { tokens: number; source: string };
  measured?: { input: number; cached?: number; at: number; stale: boolean; source: string };
  estimated: { total: number; tokenizer: string }; unexplained?: number;
  categories: Array<{ key: CategoryKey; label: string; items: number;
    tokens: { estimated?: number; measured?: number }; provenance: Provenance; unavailable_items?: number; note?: string }>;
  messages: Array<{ index: number; kind: string; category: string; provenance: string;
    tokens: { estimated?: number; measured?: number }; preview: string; ref?: ContentRef; ts?: number; callId?: string }>;
  notes: string[];
};
export type ContextOptions = {
  at?: string; phase?: 'before' | 'after'; codexHome?: string; dataDir?: string;
  windowTokens?: number | Partial<Record<'codex' | 'pi', number>>;
  contextUsage?: { all(): Array<{ backend: string; key: string; windowTokens: number }> };
};
export type AdapterSet = Partial<Record<'codex' | 'pi', SessionAdapter>>;
/** 内部仅保存估算与短预览，不缓存整份 rollout 正文。 */
export type HistoryMessage = Omit<ContextAnalysis['messages'][number], 'index' | 'category' | 'provenance'> & {
  category: CategoryKey; provenance: Provenance; role?: string; itemType?: string; id?: string;
  boundary?: boolean; contextual?: boolean; external?: boolean; toolName?: string;
  location?: { file: string; offset: number }; truncated?: boolean; hidden?: boolean;
  mediaViews?: Record<number, Pick<HistoryMessage, 'preview' | 'tokens' | 'hidden' | 'provenance'>>;
  legacyText?: { bytes: number; head: string; tail: string };
};
export type HistoryResult = {
  messages: HistoryMessage[]; notes: string[]; measured?: ContextAnalysis['measured'];
  window?: ContextAnalysis['window']; tokenizer?: string;
};

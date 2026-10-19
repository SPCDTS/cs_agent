/** Pi 后端提供的只读会话源契约，观测适配器按此读取公开会话记录。 */
import type { ContextView, EntryRecord } from '@earendil-works/pi-durable';

export type PiConversation = {
  id: string; label: string; scope?: string; status: 'active' | 'archived';
  started?: number; updated?: number;
};
export type PiEntryPage = { items: readonly EntryRecord[]; cursor?: string; hasMore: boolean };

/** 仅封装 pi-durable 公开接口；游标是最后读到的 entry ID，用于后续 minEntryId 扫描。 */
export interface PiSessionSource {
  listConversations(): Promise<PiConversation[]>;
  entries(id: string, cursor?: string, limit?: number): Promise<PiEntryPage>;
  context(id: string, at?: string): Promise<ContextView>;
  /** 实际后端使用 watchEvents；注入源没有实时总线时由适配器轮询。 */
  subscribe?(id: string, cb: () => void): Promise<() => void>;
}

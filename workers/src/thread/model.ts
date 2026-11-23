import type { Target, TurnKind } from '../policy';

export type InboundRow = {
  agent_from?: string | null; agent_hash?: string | null; agent_files?: string | null; agent_authority?: string | null;
  message_id: string; platform_message_id: string; user_id: string; self_id: string; text: string; received_at: number; admitted_at?: number | null;
  status: "queued" | "done" | "failed"; chat_kind: "private" | "group"; chat_id: string; nickname: string;
  persona_text: string | null; session_generation: number; reply_channel: "qq" | "web"; scope_name: string; turn_id: string | null; when_busy: "steer" | "followUp" | null; kind: TurnKind;
};

// 档位绑定本轮来源，不能让事件或网页回合继承其他回合的工具权限。
export type ToolProfile = 'chat' | 'event' | 'web' | 'agent';
export const isWeb = (row: InboundRow) => row.reply_channel === 'web';
export const isWebAdmin = (row: InboundRow) => isWeb(row) && row.user_id === 'admin:web';
export const profileOf = (row: InboundRow): ToolProfile => row.kind === 'agent' ? 'agent' : isWeb(row) ? 'web' : row.kind === 'event' ? 'event' : 'chat';
export const targetOf = (row: InboundRow): Target => row.chat_kind === 'group' ? { kind: 'group', groupId: row.chat_id } : { kind: 'private', userId: row.chat_id };

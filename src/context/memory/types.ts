/**
 * 记忆层的数据契约（docs/MEMORY-DESIGN.md §4）：条目、版本、关系、命名空间与查询参数。
 * 只描述数据形状与限额，不认识权限；命名空间的读写范围由 agent/memory/service.ts 按本轮权限求出。
 */
import { z } from "zod";

export const MEMORY_KINDS = ["fact", "preference", "rule", "commitment", "episode"] as const;
export type MemoryKind = typeof MEMORY_KINDS[number];
export const MEMORY_STATUSES = ["active", "superseded", "retired", "orphaned", "forgotten"] as const;
export type MemoryStatus = typeof MEMORY_STATUSES[number];

/** 条目正文 ≤500 字、subject ≤40 字、画像 ≤4 KiB（§11）。 */
export const MEMORY_TEXT_MAX = 500;
export const MEMORY_SUBJECT_MAX = 40;
export const PROFILE_MAX_BYTES = 4 * 1024;
/** 每命名空间 active 条目软上限：超过只告警，不拒写。 */
export const MEMORY_ACTIVE_SOFT_CAP = 2000;

const NS_RE = /^(?:owner|(?:group|private):[1-9][0-9]{0,19})$/;
/** 命名空间与会话键一致：owner、group:<群号>、private:<QQ号>。 */
export function isMemoryNs(value: unknown): value is string {
  return typeof value === "string" && NS_RE.test(value);
}

export const memoryKind = z.enum(MEMORY_KINDS);
export const memoryStatus = z.enum(MEMORY_STATUSES);
export const memoryNs = z.string().refine(isMemoryNs, "命名空间必须是 owner、group:<群号> 或 private:<QQ号>");
export const memoryText = z.string().trim().min(1, "正文不能为空").max(MEMORY_TEXT_MAX, `正文不超过 ${MEMORY_TEXT_MAX} 字`);
export const memorySubject = z.string().trim().min(1).max(MEMORY_SUBJECT_MAX, `subject 不超过 ${MEMORY_SUBJECT_MAX} 字`);

export interface MemoryRow {
  id: number;
  ns: string;
  kind: MemoryKind;
  subject: string | null;
  text: string;
  /** 生效与失效时间（unix 秒）；until 为空表示仍然有效；episode 的 since 是事件日期 */
  since: number | null;
  until: number | null;
  /** 只有 commitment 用 */
  due_at: number | null;
  done_at: number | null;
  status: MemoryStatus;
  /** qq:<号>（模型在该人回合写入）、extractor、dashboard */
  author: string;
  source_scope: string | null;
  source_message_id: string | null;
  source_turn_id: string | null;
  confidence: number;
  created_at: number;
  updated_at: number;
  last_recalled_at: number | null;
  recall_count: number;
  /** sha256(ns + kind + 规整后的 text)，精确去重 */
  hash: string;
}

export interface MemoryVersionRow {
  id: number;
  memory_id: number;
  at: number;
  /** 作者（qq:<号> / dashboard / extractor）或 consolidate:<batch_id> */
  by: string;
  before_json: string | null;
  after_json: string;
  reason: string | null;
}

export type MemoryRel = "supersedes" | "related";
export interface MemoryLinkRow { from_id: number; to_id: number; rel: MemoryRel; created_at: number }

/** 新条目：ns / kind / text 必填，其余按需。 */
export interface MemoryInput {
  ns: string;
  kind: MemoryKind;
  text: string;
  subject?: string | null;
  since?: number | null;
  until?: number | null;
  due_at?: number | null;
  author: string;
  source_scope?: string | null;
  source_message_id?: string | null;
  source_turn_id?: string | null;
  confidence?: number;
}

/** 正文或时效的修改；null 表示清空。 */
export interface MemoryPatch {
  text?: string;
  subject?: string | null;
  since?: number | null;
  until?: number | null;
  due_at?: number | null;
  done_at?: number | null;
}

/** 读取范围：命名空间列表或全部（owner 私聊线程）。 */
export type MemoryScope = "all" | readonly string[];

export interface MemoryQuery {
  scope: MemoryScope;
  /** 检索词：按空白切分，最多 5 个，全部命中（trigram FTS 的 LIKE 匹配） */
  query?: string;
  kind?: MemoryKind;
  subject?: string;
  /** 缺省 active */
  status?: MemoryStatus;
  ns?: string;
  limit: number;
  offset?: number;
}

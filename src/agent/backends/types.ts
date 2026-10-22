/**
 * 执行 agent 的后端公共类型（docs/ARCHITECTURE.md §2.4）。两后端：codex（常驻 app-server，§4.1）与 pi（进程内常驻会话）；
 * 二者都实现 ThreadHost 的 ThreadAdapter，回复只经 send_message（Outbox）发出。
 */
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export type ThreadKey = "owner" | `group:${string}` | `private:${string}`;
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** 每轮开始时冻结；档位与后端按快照执行。Pi 的模型记录用于审计，提交时可读取当前模型。 */
export type SettingsSnapshot = {
  backend: BackendName;
  codexReasoningEffort: ReasoningEffort;
  codexModel?: string;
  piModel?: string;
  piThinkingLevel?: ModelThinkingLevel;
  effortSource?: "fixed" | "auto" | "auto-fallback";
};

/** 输入来源（来源头用）：定时输入的 user_id 为创建者。 */
export type InputSource = {
  type: "private" | "group";
  user_id: string;
  group_id: string | null;
  group_name?: string;
  nickname: string;
};

export type BackendName = "codex" | "pi";
export const BACKEND_NAMES = ["codex", "pi"] as const;

/** 注册到选择器的后端（实现另见 ThreadAdapter）。 */
export interface AgentBackend {
  readonly name: BackendName;
}

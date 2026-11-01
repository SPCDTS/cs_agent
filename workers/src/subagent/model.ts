import type { McpCapabilitySnapshot } from "../mcp/access";
import type { ModelSelection } from "../settings";
import type { TurnKind } from "../policy";
import type { AgentDescription } from "./activity";

/** 派出者：QQ 身份或可信网页管理员、显示昵称与会话权限快照。 */
export type SubagentPerson = { userId: string; nickname: string; owner: boolean; admin?: true };
/** 派出或交代任务那一轮的身份快照（docs/ARCHITECTURE.md 的身份与权限）；没有 as 表示只剩会话基础权限。 */
export type SubagentIdentity = { turn: TurnKind; as?: SubagentPerson };
export type SubagentStatus = "running" | "done" | "failed" | "cancelled";
/** timeout 只在父线程：由父 DO 的 alarm 判定，子 DO 只知道自己被取消。 */
export type ParentSubagentStatus = SubagentStatus | "timeout";
/** 子 DO 的状态与单调版本；父线程只采纳更新的版本，所以消息、汇报与取消的 RPC 无论先后到达都收敛到同一状态。 */
export type SubagentState = { status: SubagentStatus; version: number };
export type SubagentCapabilities = { sandboxTask?: string; mcp?: McpCapabilitySnapshot; coding?: boolean; remoteSandbox?: boolean };
export type SubagentMeta = {
  parent: string; id: string; task: string; createdAt: number; identity: SubagentIdentity; model: ModelSelection;
  summary?: string; progress?: AgentDescription; activityAt?: number;
  capabilities?: SubagentCapabilities; status: SubagentStatus; endedAt?: number; reportCount: number; version: number;
};
export type SubagentStart = Pick<SubagentMeta, "parent" | "id" | "task" | "summary" | "identity" | "model" | "capabilities">;
export type SubagentReport = {
  subagentId: string; requestId: string; text: string; identity: SubagentIdentity; outcome: "done" | "failed"; state: SubagentState;
};
export type SubagentEntry = { id: number; kind: string; role?: string; text: string };

export const MIN_TIMEOUT_MS = 1000;
export const RETENTION_MS = 14 * 86400_000;
export const SUBAGENT_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export const subagentName = (parent: string, id: string) => `sub:${parent}:${id}`;
export const reportKey = (id: string, requestId: string) => `subagent-report:${id}:${requestId}`;
export const clip = (text: string, max: number) => text.length > max ? text.slice(0, max) + `…（截断，共 ${text.length} 字）` : text;

/** 后来交代任务的回合与已登记的身份合并：同一人（owner 多账号算同一人）才保留，否则降为基础权限；只降不升。 */
export function narrowIdentity(current: SubagentIdentity, next: SubagentIdentity): SubagentIdentity {
  const a = current.as, b = next.as;
  const as = !a || !b ? undefined : a.userId === b.userId ? { ...a, owner: a.owner && b.owner } : a.owner && b.owner ? a : undefined;
  return { turn: next.turn, ...(as ? { as } : {}) };
}

/** QQ 身份须与当前配置一致；网页管理员身份只由鉴权后的宿主构造，不从模型参数读取。 */
export function confirmedIdentity(identity: SubagentIdentity, owners: readonly string[]): SubagentIdentity {
  const as = identity.as;
  return as && (as.admin === true && as.userId === "admin:web" || as.owner === owners.includes(as.userId)) ? identity : { turn: identity.turn };
}

const LABEL = { done: "[子 agent 完成]", failed: "[子 agent 失败]", timeout: "[子 agent 超时]" } as const;
export function reportText(kind: keyof typeof LABEL, id: string, task: string, text: string): string {
  return `${LABEL[kind]} id=${id} 任务：${clip(task.replace(/\s+/g, " "), 80)}\n${clip(text, 8000)}`;
}

/** 由父线程键与派出工具调用的任务 id 求出子 agent id：工具重放得到同一个 id，不会重复派出。 */
export async function stableId(seed: string): Promise<string> {
  const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)))].map(b => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

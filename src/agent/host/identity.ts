/**
 * 回合身份与权限（docs/ARCHITECTURE.md §5.1）：每个回合绑定一个人，所有权限检查（发送与 target、历史与图片召回的读取范围、
 * 参考图、定时工具、授权工具、授权表）都经由这里求出，各处不再按回合类型或 owner 线程自行判断。
 *
 * 两层：
 * - base(threadKey, scope)：会话基础权限，任何回合都有——读本会话范围、只发往本会话；没有 target、定时与授权工具。
 * - elevation(identity)：本轮确证绑定的人带来的权限，只在确证时返回：
 *   用户回合 → 发送者（owner 多账号算同一人）；定时回合 → 创建者（没有授权工具，授权表照常复核）；
 *   唤醒回合 → 派出子 agent 那一轮的人（派出时快照，随汇报带回；唤醒回合派出的再继承，形成链）。
 *   无法确证（没有派出记录、未知的 run、数据缺失或不一致）一律返回 undefined，只剩基础权限，绝不向上回落。
 * - 同一唤醒回合带回多个汇报：全部是同一人、同一类型才继承，否则回落到基础权限（mergePersons）。
 */
import { isScope } from "../../context/access.js";
import { isOwner, type OwnerIds } from "../../shared/owners.js";
import type { RunPerson, TurnIdentity } from "../../channel/types.js";

export type { RunPerson };

const QQ = /^[1-9][0-9]{0,19}$/;

/** 本轮权限：base 之上只在确证时叠加 person 的权限。 */
export type RunRights = {
  threadKey: string;
  /** 本会话的投递地址（基础权限的读写范围） */
  scope: string;
  /** 本轮确证绑定的人；缺省 = 只有会话基础权限 */
  person?: RunPerson;
  /** 授权表与定时按它查：qq:<person> */
  actor?: string;
  /** 读取范围：owner 在自己的私聊线程为 all，其余（包括 owner 在群里）为本会话 */
  access: string;
  /** owner 本人：免授权表、skill_publish */
  owner: boolean;
  /** 授权工具：owner 的交互身份（定时身份没有） */
  auth: boolean;
};

/** 会话基础权限：读本会话范围、只发往本会话；没有 target、定时与授权工具。 */
export function base(threadKey: string, scope: string): RunRights {
  if (!isScope(scope)) throw new Error("回合会话地址无效");
  return { threadKey, scope, access: scope, owner: false, auth: false };
}

/**
 * 本轮确证绑定的人；无法确证返回 undefined。
 * owner 以当前配置为准；继承来的还须快照时就是 owner（只降不升）。
 */
export function elevation(identity: TurnIdentity, owners: OwnerIds): RunPerson | undefined {
  const claimed: RunPerson | undefined = identity.kind === "user" ? { kind: "user", person: identity.sender, owner: true }
    : identity.kind === "scheduled" ? { kind: "scheduled", person: identity.creator, owner: true }
    : identity.kind === "event" ? { kind: "event", person: identity.creator, owner: true }
    : identity.inherited;
  if (!validPerson(claimed)) return undefined;
  if (claimed.kind === "event" && !isOwner(owners, claimed.person)) return undefined;
  // 继承来的快照与当前 owner 配置不一致（之后被加入或移出 owner）：下游按 actor 重新判断 owner 的地方会与快照冲突，回落基础权限。
  if (identity.kind === "wake" && claimed.owner !== isOwner(owners, claimed.person)) return undefined;
  return { kind: claimed.kind, person: claimed.person, owner: claimed.owner === true && isOwner(owners, claimed.person) };
}

/** 本轮权限 = base ∪ elevation。所有权限检查都经由它。 */
export function runRights(binding: { threadKey: string; scope: string; identity: TurnIdentity }, owners: OwnerIds): RunRights {
  const rights = base(binding.threadKey, binding.scope);
  const person = elevation(binding.identity, owners);
  if (!person) return rights;
  // 读取全部只在 owner 私聊线程：共享会话（群）的线程历史对会话里所有人可见，读进来的别处记录会被后来的人间接看到。
  return { ...rights, person, actor: `qq:${person.person}`, access: person.owner && binding.threadKey === "owner" ? "all" : rights.scope,
    owner: person.owner, auth: person.owner && person.kind === "user" };
}

/** 形状校验：快照来自持久化数据，不可信任其类型。 */
export function validPerson(value: unknown): value is RunPerson {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  return (p.kind === "user" || p.kind === "scheduled" || p.kind === "event") && typeof p.person === "string" && QQ.test(p.person) && typeof p.owner === "boolean";
}

/**
 * 多份身份合并为一个回合的身份（最严格）：全部确证、同一类型、同一人（owner 多账号算同一人）且 owner 标记一致才保留，
 * 否则 undefined（基础权限）。空列表也是 undefined。
 */
export function mergePersons(persons: readonly (RunPerson | undefined)[]): RunPerson | undefined {
  const [first] = persons;
  if (!validPerson(first)) return undefined;
  for (const p of persons.slice(1)) {
    if (!validPerson(p) || p.kind !== first.kind || p.owner !== first.owner || (p.person !== first.person && !(p.owner && first.owner))) return undefined;
  }
  return { kind: first.kind, person: first.person, owner: first.owner };
}

/** 事件读取身份不能用于写操作或委派。 */
export const isEventTurn = (rights: RunRights): boolean => rights.person?.kind === "event";

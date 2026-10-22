import { defineDoc } from "@earendil-works/pi-durable";
import type { TurnBinding } from "../../channel/types.js";

/**
 * 子 agent 会话的绑定（docs/ARCHITECTURE.md §4.3）：创建子会话的同一提交写入父会话的会话键。
 * 子会话共用父会话的工作区与附件目录，只有会话基础权限（只读本会话范围，不能主动发送、定时或授权）。
 */
export const PiChildDoc = defineDoc<{ threadKey: string; parent: number }>({
  kind: "cs.pi.child", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ threadKey: "", parent: 0 }),
});

/**
 * 工具调用时由宿主求出的本轮绑定（§5.1）：身份、发送地址与本轮输入来自会话宿主，模型参数不能覆盖；
 * 下列权限均由 host/identity.ts 的 runRights 求出：access 为读取范围（owner 本人为 all，其余为本会话），
 * senderIsOwner 决定技能写权限，auth 为授权工具（owner 的交互身份，子会话没有）。
 */
export interface PiCallBinding extends TurnBinding {
  access: string;
  senderIsOwner: boolean;
  auth: boolean;
  /** 子 agent 会话 */
  child: boolean;
}

/** 回合级观测键：回合内为 turn:<id>，没有回合（子 agent 在父回合结束后仍在工作）为 thr:<会话键>。 */
export function traceKey(binding: Pick<TurnBinding, "turnId" | "threadKey"> | undefined): string {
  if (!binding) return "@pi";
  return binding.turnId ? "turn:" + binding.turnId : "thr:" + binding.threadKey;
}

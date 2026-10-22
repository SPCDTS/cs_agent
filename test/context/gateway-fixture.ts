/** 线程令牌测试用的网关：按会话键给出固定的单次调用绑定（真实网关由 codex 适配器按宿主当前回合求出）。 */
import { vi } from "vitest";
import type { Access } from "../../src/context/access.js";
import type { CallBinding, CallMeta, ThreadGateway } from "../../src/context/media-recall-server.js";

export function callBinding(threadKey: string, access: Access, extra: Partial<CallBinding> = {}): CallBinding {
  return { threadKey, turnId: "codex:t1", identity: { kind: "user", sender: "5" }, scope: threadKey === "owner" ? "private:1" : threadKey,
    inputs: [], access, workdir: "/workspace/x", session: "thread-1", imageDir: "/data/images/x", imageRefs: [], ...extra };
}

/** access：会话键 → 读取范围；turnOf：按调用元数据给出回合（缺省 codex:<meta.turnId ?? t1>）。 */
export function staticGateway(access: (threadKey: string) => Access, extra: Partial<ThreadGateway> & { binding?: (threadKey: string, meta: CallMeta) => Partial<CallBinding> } = {}) {
  const { binding, ...rest } = extra;
  const resolve = vi.fn(async (threadKey: string, meta: CallMeta) =>
    callBinding(threadKey, access(threadKey), { turnId: "codex:" + (meta.turnId ?? "t1"), ...binding?.(threadKey, meta) }));
  const gateway: ThreadGateway = { resolve, send: async () => ({ status: "sent" }), ...rest };
  return { gateway, resolve };
}

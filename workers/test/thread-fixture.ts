import { vi } from "vitest";
import { ThreadDO } from "../src/thread";
import type { Env } from "../src/env";

/** 替换测试 bindings 时，真实 workerd alarm 也必须投递给同一实例，才能共享接纳等待者。 */
export function threadWithBindings(host: Pick<DurableObject, "alarm">, state: DurableObjectState, bindings: Env): ThreadDO {
  const thread = new ThreadDO(state, bindings);
  vi.spyOn(host, "alarm").mockImplementation(() => thread.alarm());
  return thread;
}

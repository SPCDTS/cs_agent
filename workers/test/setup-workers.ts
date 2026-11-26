import { env, listDurableObjectIds, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, vi } from "vitest";

const DO_NAMESPACES = [
  "THREAD",
  "REGISTRY",
  "REQUESTS",
  "BRIDGE",
  "SCHEDULE",
  "EVENTS",
  "SUBAGENT",
  "SANDBOX",
  "CLOUDFLARE_WORKSPACE_RESOURCES",
] as const;

afterEach(async () => {
  // workerd 的 reset() 仅重置当前活跃在 ActorNamespace 中的 DO；
  // 若某个 DO 在本用例内已因空闲/异常被驱逐，须先列举已知 ID 唤醒并清空存储。
  const bindings = env as unknown as Record<string, DurableObjectNamespace | undefined>;
  for (const name of DO_NAMESPACES) {
    const ns = bindings[name];
    if (!ns) continue;
    const ids = await listDurableObjectIds(ns);
    for (const id of ids) {
      await runInDurableObject(ns.get(id), async (_instance, state) => {
        if (
          state.storage.sql.databaseSize > 0
          || (await state.storage.getAlarm()) !== null
          || (await state.storage.list({ limit: 1 })).size > 0
        ) {
          await state.storage.deleteAll();
          await state.storage.deleteAlarm();
        }
      });
    }
  }
  await reset();
  vi.restoreAllMocks();
});

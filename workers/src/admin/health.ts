import type { Env } from "../env";
import { threadView } from "./read-views";

/** 管理员详情查询；公开存活探针不进入这里，也不读取任何 DO。 */
export async function healthReport(env: Env) {
  const owner = threadView(env, "owner"), registry = env.REGISTRY.getByName("main");
  const unavailable = () => ({ error: "unavailable" });
  const [bridge, model, thread, accounts, counts, mcpHealth, schedule, events, sandbox, alerts] = await Promise.all([
    env.BRIDGE.getByName("napcat").status().catch(() => undefined),
    registry.modelStatus().catch(() => ({ unavailable: "status_unavailable" })),
    owner.stats().catch(error => ({ error: error instanceof Error && error.message.includes("view_pending") ? "view_pending" : "unavailable" })),
    registry.status().catch(() => null),
    owner.mcpToolCounts().catch(() => null),
    owner.mcpHealth().catch(() => null),
    env.SCHEDULE.getByName("main").status().catch(unavailable),
    env.EVENTS.getByName("main").health().catch(unavailable),
    env.SANDBOX.getByName("owner").telemetry().catch(() => ({ status: "unavailable" as const })),
    registry.activeAlertCount().catch(() => null),
  ]);
  const components = {
    worker: "ready",
    bridge: bridge === undefined ? "unavailable" : bridge.connected ? "ready" : "degraded",
    model: "unavailable" in model ? "unavailable" : "ready",
  } satisfies Record<"worker" | "bridge" | "model", "ready" | "degraded" | "unavailable">;
  const { threads, sendRules, ...connection } = bridge ?? { threads: null, sendRules: null, error: "unavailable" };
  return {
    overall: components.bridge === "ready" && components.model === "ready" ? "ready" : "degraded",
    components, commit: env.JOULE_COMMIT, bridge: connection, model, thread, threads, sendRules,
    mcp: accounts?.map(account => ({
      ...account,
      tools: counts === null ? null : counts[account.server] ?? 0,
      ...(mcpHealth?.[account.server] ? { health: mcpHealth[account.server] } : {}),
    })) ?? null,
    schedule, events, sandbox,
    alerts: alerts !== null ? { active: alerts } : null,
  };
}

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { resolveAutoEffort, type EffortMessage, type EffortRouterDeps } from "./effort-router.js";
import { backendNameFor, type BackendSelector } from "./backends/select.js";
import type { TicketSettings } from "./backends/types.js";
import { isReasoningEffort } from "./codex/runner.js";
import type { RuntimeSettings } from "./settings.js";

export interface TurnSettingsDeps {
  backends?: Pick<BackendSelector, "select">;
  /** 生产入口一次读取全部设置，避免分别采样。 */
  currentSettings?: () => Readonly<RuntimeSettings>;
  codexReasoningEffort?: string | (() => string);
  piThinkingLevel?: ModelThinkingLevel;
  effortRouter?: EffortRouterDeps;
}

/**
 * 每轮开始时冻结后端、模型与档位（设计附录 A 第 10 项：推理强度路由按本轮输入计算）。
 * 档位为 auto 时按本轮输入文本路由；定时与唤醒回合同样适用。
 */
export function createTurnSettings(deps: TurnSettingsDeps) {
  return async (scope: string, msg?: EffortMessage): Promise<TicketSettings> => {
    // 必须在第一个 await 之前一次采样，排队期间的设置变更不影响本轮。
    const current = deps.currentSettings?.();
    const configured = typeof deps.codexReasoningEffort === "function" ? deps.codexReasoningEffort() : deps.codexReasoningEffort;
    const codexFallback = isReasoningEffort(configured) ? configured : "high";
    const piFallback = deps.piThinkingLevel ?? "low";
    const effort = current?.codexReasoningEffort ?? codexFallback;
    const backend = current ? backendNameFor(scope, current.agentBackend, current.backendOverrides) : deps.backends?.select(scope).name ?? "codex";
    const snapshot: TicketSettings = { backend, codexReasoningEffort: isReasoningEffort(effort) ? effort : codexFallback,
      ...(current ? { codexModel: current.codexModel, piModel: current.piModel,
        piThinkingLevel: current.piThinkingLevel === "auto" ? piFallback : current.piThinkingLevel } : {}), effortSource: "fixed" };
    const input = msg ?? { ticket: "@effort", text: "", hasImages: false, hasQuote: false };
    if (backend === "codex" && effort === "auto") {
      const routed = await resolveAutoEffort(deps.effortRouter ?? {}, input, codexFallback);
      snapshot.codexReasoningEffort = routed.effort; snapshot.effortSource = routed.source;
    } else if (backend === "pi" && current?.piThinkingLevel === "auto") {
      const routed = await resolveAutoEffort(deps.effortRouter ?? {}, input, piFallback);
      snapshot.piThinkingLevel = routed.effort; snapshot.effortSource = routed.source;
    }
    return snapshot;
  };
}

export type TurnSettings = ReturnType<typeof createTurnSettings>;

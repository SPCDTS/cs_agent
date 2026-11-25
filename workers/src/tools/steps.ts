import type { Context } from "@earendil-works/chord/context";
import { Type } from "typebox";
import { defineExtension, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { safeText } from "../requests/snapshot";
import { StepItem, type StepStatus } from "../requests/tool-types";

export const STEPS_STORAGE_KEY = "thread_steps";
export const STEPS_TTL_MS = 12 * 3600_000;

export type SavedThreadSteps = {
  generation: number;
  updatedAt: number;
  steps: StepItem[];
};

export function isOpenStep(status: StepStatus): boolean {
  return status === "pending" || status === "in_progress";
}

export function formatTurnStepsContext(steps: readonly StepItem[]): string | undefined {
  if (!steps.length || !steps.some(step => isOpenStep(step.status))) return undefined;
  const completed = steps.filter(step => step.status === "done" || step.status === "skipped").length;
  const lines = steps.map((step, idx) => `${idx + 1}. [${step.status}] ${step.title}`);
  return `当前任务步骤清单（已完成 ${completed}/${steps.length}；阶段推进或收尾时请用 update_steps 更新状态，若用户已切换至无关新话题请覆盖或传空数组清空）：\n${lines.join("\n")}`;
}

export async function loadActiveThreadSteps(
  storage: Pick<DurableObjectStorage, "get" | "delete">,
  generation: number,
  now = Date.now(),
): Promise<StepItem[] | undefined> {
  const saved = await storage.get<SavedThreadSteps>(STEPS_STORAGE_KEY);
  if (!saved) return undefined;
  if (saved.generation !== generation || now - saved.updatedAt > STEPS_TTL_MS || !saved.steps.some(s => isOpenStep(s.status))) {
    await storage.delete(STEPS_STORAGE_KEY);
    return undefined;
  }
  return saved.steps;
}

export type StepsExtensionDeps = {
  storage: Pick<DurableObjectStorage, "get" | "put" | "delete">;
  currentTurn(api: ToolExecutionApi, context: Context): Promise<{ generation: number; allowed: boolean } | undefined>;
};

export function createStepsExtension(deps: StepsExtensionDeps) {
  return defineExtension({
    name: "cs.steps",
    tools: [{
      ...defineTool({
        name: "update_steps",
        description: "维护当前多步任务的进度清单（在管理台网页实时展示步骤卡片，不向 QQ 群发刷屏）。当任务包含 3～12 个明确步骤（尤其是并行调用工具、派发多个 subagent、跨回合推进或需向用户确认进度/收尾汇报的任务）时使用；1～2 步简单问答不调用。每次传入完整有序列表全量替换旧列表（传空数组 [] 清空）：当前执行项标为 in_progress（并行时可多项同时 in_progress），其余标为 pending、done、skipped 或 failed；建议将「调用 send_message 向用户汇报/确认」列为末步，并在首个动作工具同一轮并行调用、全部完成时标为 done。",
        parameters: Type.Object({
          steps: Type.Array(StepItem, {
            maxItems: 12,
            description: "完整有序步骤列表（最多 12 项，每次调用全量覆盖；传 [] 清空）。",
          }),
        }, { additionalProperties: false }),
        replay: "safe",
        execute: async ({ steps }, api, context) => {
          const turn = await deps.currentTurn(api, context);
          if (!turn?.allowed) {
            return { isError: true, output: [{ type: "text", text: "steps_denied：当前回合不支持更新步骤清单。" }] };
          }
          const normalized: StepItem[] = [];
          for (const item of steps) {
            const title = safeText(item.title).replace(/\s+/g, " ").trim().slice(0, 120);
            if (!title) {
              return { isError: true, output: [{ type: "text", text: "invalid_step_title：步骤标题不能为空。" }] };
            }
            normalized.push({ title, status: item.status });
          }
          const open = normalized.filter(s => isOpenStep(s.status)).length;
          const completed = normalized.filter(s => s.status === "done" || s.status === "skipped").length;
          if (open > 0) {
            const record: SavedThreadSteps = { generation: turn.generation, updatedAt: Date.now(), steps: normalized };
            await deps.storage.put(STEPS_STORAGE_KEY, record);
          } else {
            await deps.storage.delete(STEPS_STORAGE_KEY);
          }
          return {
            output: [{
              type: "text",
              text: JSON.stringify({ ok: true, completed, total: normalized.length, open }),
            }],
          };
        },
      }),
      callers: ["model"] as const,
    }],
  });
}

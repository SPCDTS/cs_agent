import type { Context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Env } from "../env";
import { ModelSelectionSchema, type ModelSelection } from "../settings";
import { SUBAGENT_ID } from "../subagent/model";
import { classifyError } from "../shared/diagnostics";

export type ModelManagementDeps = {
  env: Env;
  /** 仅限主人会话（owner）内确证 owner 的非 subagent 用户消息回合（排除 SubagentDO、kind=subagent 汇报回合、event、schedule 与群聊）。 */
  allowed(api: ToolExecutionApi, context: Context): Promise<boolean>;
  /** 刷新本线程模型目录缓存并立即将最新主模型同步到当前会话 root。 */
  syncSelfModel(): Promise<void>;
  /** 查询指定模型是否声明支持推理强度设置。 */
  modelReasoning(provider: string, id: string): boolean;
  /** 按 ID 切换本会话内某个已存在子 agent 的模型。 */
  setSubagentModel(api: ToolExecutionApi, context: Context, subagentId: string, model: ModelSelection): Promise<{ text: string; error?: true }>;
  audit(detail: { target: string; model?: string; subagentId?: string; result: string }): Promise<unknown>;
};

const REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

const PARAMETERS = Type.Object({
  action: Type.Union([Type.Literal("list"), Type.Literal("set")]),
  target: Type.Optional(Type.Union([
    Type.Literal("self"),
    Type.Literal("subagent"),
    Type.Literal("both"),
  ], { description: "set 必填：self 修改主 agent 模型；subagent 修改子 agent 默认模型（或配合 subagentId 修改指定子任务）；both 同时修改主模型并令子任务默认跟随主模型。" })),
  model: Type.Optional(Type.Object({
    ...ModelSelectionSchema.properties,
  }, { additionalProperties: false, description: "目标模型 { provider, id, reasoningEffort? }；必须来自 list 返回的 available=true 供应商模型列表。" })),
  inheritSelf: Type.Optional(Type.Boolean({ description: "仅当 target='subagent' 且未指定 subagentId 时可用：传 true 清除子任务独立默认模型，恢复跟随主模型。" })),
  subagentId: Type.Optional(Type.String({ pattern: `^${SUBAGENT_ID}$`, description: "可选（配合 target='subagent' 与 model）：仅切换本会话指定子 agent 实例的模型，不改全局默认。" })),
}, { additionalProperties: false });

function jsonOut(value: unknown, isError = false): ToolExecutionResult {
  return {
    ...(isError ? { isError: true } : {}),
    output: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
  };
}

export function createModelManagementExtension(deps: ModelManagementDeps) {
  return defineExtension({
    name: "cs.model-management",
    tools: [{
      ...defineTool({
        name: "model_manage",
        description: "查看可用模型目录或切换主 agent / 子 agent 模型（仅限 owner 权限的非 subagent 交互回合；子 agent 自身不可用）。切换前可先调 action='list' 确认可用 provider 与 model id；target 支持 self（主模型）、subagent（子任务默认模型，或传 subagentId 改单个子任务，或传 inheritSelf=true 恢复跟随主模型）、both（主模型与子任务默认同步切换）。",
        parameters: PARAMETERS,
        replay: "unsafe",
        execute: async (args, api, context) => {
          if (!await deps.allowed(api, context)) {
            await deps.audit({ target: args.target ?? args.action, result: "denied" }).catch(() => {});
            return jsonOut("model_denied：仅限 owner 权限的非 subagent 交互回合查看或修改模型配置。", true);
          }

          const registry = deps.env.REGISTRY.getByName("main");

          if (args.action === "list") {
            await deps.syncSelfModel().catch(() => {});
            const view = await registry.modelView();
            return jsonOut({
              self: view.current,
              subagentDefault: view.subagent ?? null,
              effectiveSubagentDefault: view.subagent ?? view.current,
              reasoningEfforts: REASONING_EFFORTS,
              codexStatus: view.codex.status,
              providers: view.providers.map(provider => ({
                ...provider,
                models: provider.models.map(item => {
                  const reasoning = deps.modelReasoning(provider.id, item.id);
                  return { ...item, reasoning, ...(reasoning ? { reasoningEfforts: REASONING_EFFORTS } : {}) };
                }),
              })),
            });
          }

          if (!args.target) {
            return jsonOut("invalid_arguments：action='set' 必须指定 target（'self' | 'subagent' | 'both'）。", true);
          }

          if (args.subagentId) {
            if (args.target !== "subagent" || !args.model || args.inheritSelf) {
              return jsonOut("invalid_arguments：指定 subagentId 时必须设置 target='subagent' 且提供 model（不能同时传 inheritSelf）。", true);
            }
            try {
              const res = await deps.setSubagentModel(api, context, args.subagentId, args.model);
              return jsonOut(res.error ? res.text : { status: "updated", target: "subagent_instance", subagentId: args.subagentId, model: args.model, message: res.text }, Boolean(res.error));
            } catch (error) {
              const code = classifyError(error).code ?? "update_failed";
              await deps.audit({ target: "subagent_instance", subagentId: args.subagentId, model: `${args.model.provider}/${args.model.id}`, result: code }).catch(() => {});
              return jsonOut(`model_error：${code}`, true);
            }
          }

          if (args.inheritSelf) {
            if (args.target !== "subagent" || args.model) {
              return jsonOut("invalid_arguments：inheritSelf=true 仅用于 target='subagent' 且不能同时提供 model。", true);
            }
            try {
              const saved = await registry.updateModels({ subagentModel: null });
              if (!saved.ok) {
                await deps.audit({ target: "subagent", result: saved.reason }).catch(() => {});
                return jsonOut({ error: saved.error, reason: saved.reason }, true);
              }
              let synced = true, syncError: string | undefined;
              try { await deps.syncSelfModel(); }
              catch (err) { synced = false; syncError = classifyError(err).code ?? "sync_failed"; }
              await deps.audit({ target: "subagent", model: "inherit_self", result: synced ? "ok" : "sync_failed" }).catch(() => {});
              const current = saved.current.value;
              return jsonOut({
                status: "updated",
                synced,
                ...(syncError ? { syncError } : {}),
                target: "subagent",
                self: current.model,
                subagentDefault: null,
                effectiveSubagentDefault: current.model,
              });
            } catch (error) {
              const code = classifyError(error).code ?? "update_failed";
              await deps.audit({ target: "subagent", result: code }).catch(() => {});
              return jsonOut(`model_error：${code}`, true);
            }
          }

          if (!args.model) {
            return jsonOut("invalid_arguments：action='set' 必须提供 model（或对 target='subagent' 传 inheritSelf=true）。", true);
          }

          const label = `${args.model.provider}/${args.model.id}`;
          try {
            const patch = args.target === "self"
              ? { model: args.model }
              : args.target === "subagent"
                ? { subagentModel: args.model }
                : { model: args.model, subagentModel: null };
            const saved = await registry.updateModels(patch);
            if (!saved.ok) {
              await deps.audit({ target: args.target, model: label, result: "invalid_model" }).catch(() => {});
              return jsonOut({ error: saved.error, reason: saved.reason, message: "目标模型未配置或不可用，请先调用 model_manage(action='list') 查看可用模型。" }, true);
            }
            let synced = true, syncError: string | undefined;
            try { await deps.syncSelfModel(); }
            catch (err) { synced = false; syncError = classifyError(err).code ?? "sync_failed"; }
            await deps.audit({ target: args.target, model: label, result: synced ? "ok" : "sync_failed" }).catch(() => {});
            const current = saved.current.value;
            return jsonOut({
              status: "updated",
              synced,
              ...(syncError ? { syncError, warning: "已写入全局设置，但本回合运行时同步失败，将在下一回合生效。" } : {}),
              target: args.target,
              self: current.model,
              subagentDefault: current.subagentModel ?? null,
              effectiveSubagentDefault: current.subagentModel ?? current.model,
            });
          } catch (error) {
            const code = classifyError(error).code ?? "update_failed";
            await deps.audit({ target: args.target, model: label, result: code }).catch(() => {});
            return jsonOut(`model_error：${code}`, true);
          }
        },
      }),
      callers: ["model"] as const,
    }],
  });
}

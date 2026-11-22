import type { ProviderStreams } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { isRecord, withResponsesSearch } from "../hosted-search";
import type { ProviderSpec } from "../types";

export const DEEPSEEK_PROVIDER = "deepseek";

/** DeepSeek 搜索请求切到 Responses 协议；deepseek-flash 搜索工具名不同且需开启低强度推理。 */
export function withDeepSeekSearch(regular: ProviderStreams, responses: ProviderStreams = openAIResponsesApi()): ProviderStreams {
  return withResponsesSearch(regular, responses, {
    wireModel: model => ({ ...model, api: "openai-responses" }),
    patchPayload(payload, model) {
      const flash = model.id === "deepseek-flash";
      const type = flash ? "deepseek_web_search" : "web_search";
      const tools = Array.isArray(payload.tools) ? payload.tools.filter(t => !isRecord(t) || t.type !== type) : [];
      const reasoning = isRecord(payload.reasoning) ? payload.reasoning : {};
      return {
        ...payload,
        tools: [...tools, { type }],
        ...(flash && (!reasoning.effort || reasoning.effort === "none") ? { reasoning: { ...reasoning, effort: "low" } } : {}),
      };
    },
  });
}

export const DEEPSEEK_SPEC: ProviderSpec = {
  name: "DeepSeek",
  listed: () => true,
  create: () => {
    const provider = deepseekProvider();
    return { ...provider, ...withDeepSeekSearch(provider) };
  },
  unavailable: "missing_key",
  secretName: "DEEPSEEK_API_KEY",
};

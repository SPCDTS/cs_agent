import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxToolCall, fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import type { Env } from "./env";
import { createMagpieProvider, fetchMagpieCatalog, magpieProviderModels } from "./magpie";
import { installMagpieRoute, MAGPIE_CONTAINER_BASE_URL } from "./magpie-container";

export async function openModels(env: Env) {
  const models = createModels();
  const provider = env.MODEL_PROVIDER || "faux";
  const id = env.MODEL_ID || (provider === "faux" ? "test" : provider === "deepseek" ? "deepseek-flash" : "");
  switch (provider) {
    case "faux": {
      const faux = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: Infinity });
      const respond: FauxResponseFactory = transcript => {
        // 工厂也是一次性队列项，补回自身才能覆盖后续回合及驱逐后的工具续轮。
        faux.setResponses([respond]);
        if (transcript.messages.at(-1)?.role === "toolResult") return fauxAssistantMessage("done");
        const user = transcript.messages.findLast(message => message.role === "user");
        const text = typeof user?.content === "string" ? user.content
          : user?.content.filter(block => block.type === "text").map(block => block.text).join("") ?? "";
        return fauxAssistantMessage(fauxToolCall("send_message", { text: `echo: ${text}` }), { stopReason: "toolUse" });
      };
      faux.setResponses([respond]);
      models.setProvider(faux.provider);
      break;
    }
    case "deepseek":
      if (!env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY missing");
      process.env.DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY;
      models.setProvider(deepseekProvider());
      break;
    case "magpie": {
      // MAGPIE_URL 为 "container" 时走同一个 Worker 绑定的 magpie 容器（经回环中继，key 任意）；否则是外部网关，key 必填
      const inContainer = env.MAGPIE_URL === "container";
      if (inContainer) installMagpieRoute(env);
      const baseUrl = inContainer ? MAGPIE_CONTAINER_BASE_URL : env.MAGPIE_URL;
      const key = env.MAGPIE_GATEWAY_KEY || (inContainer ? "magpie-loopback" : "");
      if (!baseUrl || !key) throw new Error("magpie configuration missing");
      process.env.MAGPIE_GATEWAY_KEY = key;
      const catalog = await fetchMagpieCatalog(baseUrl, key);
      if (catalog.length === 0 && inContainer) {
        // 目录为空几乎只有一种情况：容器用缺 R2 凭据的环境起来了（secrets 后补）。销毁它，下次请求重新拉起
        await env.MAGPIE.getByName("gateway").restart();
        throw new Error("magpie catalog empty; container restarted");
      }
      models.setProvider(createMagpieProvider({ baseUrl, models: magpieProviderModels(catalog, models) }));
      break;
    }
    default: throw new Error("MODEL_PROVIDER unsupported");
  }
  if (!models.getModel(provider, id)) throw new Error("MODEL_ID unavailable");
  return { models, selection: { provider, id } };
}

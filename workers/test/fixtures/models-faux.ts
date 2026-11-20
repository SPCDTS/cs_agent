import type { Provider } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxToolCall, fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { ProviderSpec } from "../../src/models";

function echoProvider(): Provider {
  const faux = fauxProvider({ models: [{ id: "test" }, { id: "test-alt" }], tokensPerSecond: Infinity });
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
  return faux.provider;
}

export const FAUX_PROVIDER: ProviderSpec = {
  name: "faux（测试）",
  listed: env => env.MODEL_PROVIDER === "faux",
  create: echoProvider,
  unavailable: "unavailable",
};

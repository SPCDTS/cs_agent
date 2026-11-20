import { describe, expect, it } from "vitest";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { agentSearchOption, withHostedSearch } from "../src/tools/web-search";

describe("DeepSeek 服务端搜索", () => {
  const provider = deepseekProvider(), transport = withHostedSearch(provider, openAIResponsesApi());
  const context = normalizeContext({ messages: [{ role: "user", content: "查官方文档", timestamp: 1 }],
    tools: [{ name: "send_message", description: "发送消息", parameters: { type: "object", properties: {} } }] });

  it.each(provider.getModels())("$id 在同一次模型请求中声明联网和普通工具", async model => {
    let request: Request | undefined;
    const result = await transport.streamSimple(model, context, { ...agentSearchOption, apiKey: "test",
      fetch: async (url, init) => {
        request = new Request(url, init);
        const event = { type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } } };
        return new Response("data: " + JSON.stringify(event) + "\n\n", { headers: { "content-type": "text/event-stream" } });
      } }).result();
    expect(result.stopReason).toBe("stop");
    expect(request?.url).toBe("https://api.deepseek.com/responses");
    const body = await request!.json<{ tools: { type: string; name?: string }[]; reasoning?: { effort: string } }>();
    const flash = model.id === "deepseek-flash";
    expect(body.tools.map(t => t.name ?? t.type)).toEqual(["send_message", flash ? "deepseek_web_search" : "web_search"]);
    if (flash) expect(body.reasoning?.effort).toBe("low");
  });

  it("普通模型请求沿用 Chat Completions，未声明服务端搜索", async () => {
    let request: Request | undefined;
    await transport.streamSimple(provider.getModels()[0]!, context, { apiKey: "test", fetch: async (url, init) => {
      request = new Request(url, init);
      return Response.json({ error: { message: "stop" } }, { status: 400 });
    } }).result();
    expect(request?.url).toBe("https://api.deepseek.com/chat/completions");
    expect((await request!.json<{ tools: { type: string }[] }>()).tools.map(t => t.type)).toEqual(["function"]);
  });
});

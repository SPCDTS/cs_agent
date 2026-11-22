import { describe, expect, it } from "vitest";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { agentSearchOption, hostedSearchSteps } from "../src/models";
import { withDeepSeekSearch } from "../src/models/providers/deepseek";

describe("DeepSeek 服务端搜索", () => {
  const provider = deepseekProvider(), transport = withDeepSeekSearch(provider, openAIResponsesApi());
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

  it("截断后保留诊断，续轮按原顺序回传已完成的搜索及最终补齐的来源", async () => {
    const model = provider.getModels()[0]!;
    const first = { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "文档" } };
    const sources = [{ url: "https://example.org/doc" }];
    const text = { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "查到第一份" }] };
    const second = { ...first, id: "ws_2" };
    const partial = { ...first, id: "ws_3", status: "searching" };
    const events = [
      ...[first, text, second].map((item, output_index) => ({ type: "response.output_item.done", output_index, item })),
      { type: "response.output_item.added", output_index: 3, item: partial },
      { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
        output: [{ ...first, action: { sources } }, text, second, partial] } },
    ];
    const sse = (data: unknown[]) => new Response(data.map(event => "data: " + JSON.stringify(event) + "\n\n").join(""),
      { headers: { "Content-Type": "text/event-stream" } });
    const options = { ...agentSearchOption, apiKey: "test" };
    const answer = await transport.streamSimple(model, context, { ...options, fetch: async () => sse(events) }).result();
    expect(answer.stopReason).toBe("length");
    expect(hostedSearchSteps(answer).map(step => step.item.id)).toEqual(["ws_1", "ws_2", "ws_3"]);
    const next = normalizeContext({ messages: [...context.messages, answer, { role: "user", content: "继续", timestamp: 2 }] });
    let input: { type?: string; id?: string }[] = [];
    await transport.streamSimple(model, next, { ...options, fetch: async (url, init) => {
      input = (await new Request(url, init).json<{ input: typeof input }>()).input;
      return sse([{ type: "response.completed", response: { status: "completed", output: [] } }]);
    } }).result();
    expect(input.filter(i => i.id).map(i => i.id)).toEqual(["ws_1", "msg_1", "ws_2"]);
    expect(input.find(i => i.id === "ws_1")).toEqual({ ...first, action: { ...first.action, sources } });
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

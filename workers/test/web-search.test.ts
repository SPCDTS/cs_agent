import { afterEach, describe, expect, it, vi } from "vitest";
import { searchWeb } from "../src/tools/web-search";

afterEach(() => { vi.restoreAllMocks(); });

describe("DeepSeek 原生 web_search", () => {
  it("直连搜索接口，不读取全文，按相关性返回来源与摘要", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const request = new Request(url, init);
      expect(request.url).toBe("https://api.deepseek.com/v1/tools/search");
      expect(request.method).toBe("POST");
      expect(request.redirect).toBe("manual");
      expect(request.headers.get("Authorization")).toBe("Bearer synthetic-deepseek");
      expect(await request.json()).toEqual({ query: "DeepSeek 文档", count: 8, need_content: false });
      return Response.json({ results: [
        { title: "新闻", url: "https://example.test/news", date: null, summary: "", snippet: "摘要片段", rerank_score: 0.5, content: "不传给模型的全文" },
        { title: "官方文档", url: "https://api-docs.deepseek.com/guides/search/", date: "2026-10-30", summary: "接口说明", snippet: "", rerank_score: 0.9 },
      ] });
    });
    expect(await searchWeb({ apiKey: "synthetic-deepseek", query: " DeepSeek 文档 " })).toEqual([
      { title: "官方文档", url: "https://api-docs.deepseek.com/guides/search/", date: "2026-10-30", summary: "接口说明" },
      { title: "新闻", url: "https://example.test/news", date: null, summary: "摘要片段" },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("缺少 key 时不发请求，余额错误只返回可操作的原因", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("private-upstream-detail", { status: 402 }));
    await expect(searchWeb({ apiKey: undefined, query: "公开资料" })).rejects.toMatchObject({ code: "configuration" });
    expect(fetch).not.toHaveBeenCalled();
    await expect(searchWeb({ apiKey: "synthetic-deepseek", query: "公开资料" })).rejects.toMatchObject({
      code: "balance", message: "DeepSeek 余额不足，无法搜索。",
    });
  });
});

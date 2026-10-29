import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPage } from "../src/tools/web-page";

afterEach(() => { vi.restoreAllMocks(); });
/** 按地址返回固定响应；记录请求过的地址，用来断言被拒的地址根本没有发出。 */
function fakeWeb(pages: Record<string, () => Response>) {
  const requested: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const request = new Request(url, init);
    requested.push(request.url);
    expect(request.redirect).toBe("manual");
    const page = pages[request.url];
    if (!page) throw new Error(`network disabled in tests: ${request.url}`);
    return page();
  });
  return requested;
}
const redirect = (location: string) => () => new Response(null, { status: 302, headers: { Location: location } });
const html = (body: string) => () => new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });

describe("web_page fetch", () => {
  it("rejects IP literals, localhost, private suffixes and non-http schemes before any request", async () => {
    const requested = fakeWeb({});
    for (const url of ["http://127.0.0.1/", "http://2130706433/", "http://[::1]/", "http://localhost:8080/", "http://api.localhost/",
      "http://nas.local/", "http://db.internal/", "http://magpie.container/", "http://intranet/"]) {
      await expect(fetchPage(url, 8000), url).rejects.toMatchObject({ code: "blocked_host" });
    }
    for (const url of ["ftp://example.com/", "file:///etc/passwd", "https://user:pass@example.com/", "not a url"]) {
      await expect(fetchPage(url, 8000), url).rejects.toMatchObject({ code: "invalid_url" });
    }
    expect(requested).toEqual([]);
  });

  it("re-checks every redirect hop and gives up after three", async () => {
    const requested = fakeWeb({
      "https://a.example/start": redirect("/hop1"), "https://a.example/hop1": redirect("https://b.example/hop2"),
      "https://b.example/hop2": redirect("https://b.example/hop3"), "https://b.example/hop3": html("<title>终点</title><p>到了</p>"),
      "https://a.example/private": redirect("http://169.254.169.254/latest/meta-data"),
      "https://a.example/loop": redirect("https://a.example/loop"),
    });
    expect(await fetchPage("https://a.example/start", 8000)).toEqual({ title: "终点", text: "到了", truncated: false });
    await expect(fetchPage("https://a.example/private", 8000)).rejects.toMatchObject({ code: "blocked_host" });
    expect(requested).not.toContain("http://169.254.169.254/latest/meta-data");
    await expect(fetchPage("https://a.example/loop", 8000)).rejects.toMatchObject({ code: "too_many_redirects" });
    expect(requested.filter(url => url === "https://a.example/loop")).toHaveLength(4);
  });

  it("keeps title, paragraphs and link text, drops scripts and navigation, and truncates to maxChars", async () => {
    fakeWeb({ "https://a.example/article": html(`<!doctype html><html><head><title>Workers &amp; DO</title><style>p{color:red}</style></head>
      <body><nav><a href="/">首页</a> | <a href="/docs">文档</a></nav>
      <h1>标题 一</h1><p>第一段，含 <a href="https://x.example">链接文字</a>&nbsp;与 &lt;code&gt;。</p>
      <script>alert("x")</script><noscript>请启用 JS</noscript><p>第二段
        换行     空白</p><footer>版权所有</footer></body></html>`) });
    expect(await fetchPage("https://a.example/article", 8000)).toEqual({
      title: "Workers & DO", text: "标题 一\n第一段，含 链接文字 与 <code>。\n第二段 换行 空白", truncated: false });
    expect(await fetchPage("https://a.example/article", 6)).toEqual({ title: "Workers & DO", text: "标题 一\n第", truncated: true });
  });

  it("refuses non-text content and bodies over 4 MiB", async () => {
    fakeWeb({
      "https://a.example/logo.png": () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } }),
      "https://a.example/big": () => new Response("x".repeat(4 * 1024 * 1024 + 1), { headers: { "Content-Type": "text/plain" } }),
      "https://a.example/data.json": () => new Response("{\"ok\":true}", { headers: { "Content-Type": "application/json" } }),
    });
    await expect(fetchPage("https://a.example/logo.png", 8000)).rejects.toMatchObject({ code: "unsupported_type" });
    await expect(fetchPage("https://a.example/big", 8000)).rejects.toMatchObject({ code: "too_large" });
    expect(await fetchPage("https://a.example/data.json", 8000)).toEqual({ title: "", text: "{\"ok\":true}", truncated: false });
  });
});

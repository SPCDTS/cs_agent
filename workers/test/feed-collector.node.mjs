import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collect, exitCode, fetchFeed, HttpError, iso, parseFeedXml, plain, retryAt, timestamp } from "../scripts/collect_feed.mjs";

function page(...entries) {
  return { items: entries.map(date => ({ id: "t3_" + date, published: iso(date), title: "测试", text: "证据" })) };
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "collect-feed-"));
  return Promise.resolve().then(() => fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("429 限流保存已取页并在服务端冷却后携带 cursor 断点续取", () => withTempDir(async dir => {
  const output = join(dir, "run.json");
  let now = 1000;
  const requested = [];

  const reader = async url => {
    requested.push(url);
    if (requested.length === 1) return page(190, 170);
    throw new HttpError(url, 429, "120");
  };

  let result = await collect("reddit", 100, 200, output, { interval: 0, reader, clock: () => now });
  assert.equal(result.status, "waiting");
  assert.equal(result.reason, "http_error");
  assert.equal(result.retryAt, 1120);
  assert.equal(result.cursor, "t3_170");
  assert.equal(exitCode(result), 75);
  assert.equal(JSON.parse(readFileSync(output, "utf8")).items.length, 2);

  await collect("reddit", 100, 200, output, { interval: 0, reader, clock: () => now });
  assert.equal(requested.length, 2);

  now = 1120;
  const resume = async url => {
    requested.push(url);
    assert.ok(url.includes("after=t3_170"));
    return page(170, 120, 90);
  };
  result = await collect("reddit", 100, 200, output, { reader: resume, clock: () => now });
  assert.equal(result.status, "complete");
  assert.equal(exitCode(result), 0);
  assert.deepEqual(result.items.map(row => row.id), ["t3_190", "t3_170", "t3_120"]);
  assert.equal(requested.length, 3);
}));

test("HLTV 窗口未覆盖起点与 403 拒绝访问均不伪造完整覆盖或不必要重试", () => withTempDir(async dir => {
  const partial = await collect("hltv", 100, 200, join(dir, "rss.json"), { reader: async () => page(190, 170) });
  assert.equal(partial.status, "partial");
  assert.equal(partial.reason, "feed_window_incomplete");
  assert.equal(exitCode(partial), 2);

  const output = join(dir, "blocked.json");
  let calls = 0;
  const fakeFetch = async () => { calls++; return new Response("forbidden", { status: 403 }); };
  const blocked = await collect("hltv", 100, 200, output, { reader: url => fetchFeed(url, fakeFetch) });
  await collect("hltv", 100, 200, output, { reader: url => fetchFeed(url, fakeFetch) });
  assert.equal(calls, 1);
  assert.equal(blocked.status, "blocked");
  assert.equal(exitCode(blocked), 2);
}));

test("Atom/RSS 解析、脚本样式剔除、2MB 上限、时区强制与 Retry-After 冷却计算", async () => {
  const atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>t3_1</id><title>公告</title><published>2026-11-10T00:00:00Z</published><content>&lt;style&gt;p{color:red}&lt;/style&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;p&gt;正文 &amp;amp; 详情&lt;/p&gt;</content><link href="https://example.com/news"/></entry></feed>';
  const atomResult = await fetchFeed("https://example.com/feed", async () => new Response(atom, { headers: { "Content-Type": "application/atom+xml" } }));
  assert.equal(atomResult.items[0].text, "正文 & 详情");
  assert.equal(atomResult.items[0].url, "https://example.com/news");
  assert.equal(atomResult.items[0].body_status, "atom_content_requires_review");

  const rss = '<rss version="2.0"><channel><item><guid>g1</guid><title>新闻</title><link>https://example.com/1</link><pubDate>Tue, 10 Nov 2026 00:00:00 GMT</pubDate><description><![CDATA[<b>标题</b><script>x()</script>内容]]></description></item></channel></rss>';
  const rssRows = parseFeedXml(rss);
  assert.equal(rssRows[0].id, "g1");
  assert.equal(rssRows[0].text, "标题 内容");
  assert.equal(rssRows[0].body_status, "discovery_only");

  assert.equal(plain("<div>甲<style>body{}</style><span>乙</span></div>"), "甲 乙");
  assert.throws(() => timestamp("2026-11-10T00:00:00"), /timezone/);
  await assert.rejects(() => fetchFeed("https://example.com/huge", async () => new Response("a".repeat(2_000_001))), /feed_too_large/);

  const now = timestamp("2026-11-10T00:00:00Z");
  assert.equal(retryAt("Tue, 10 Nov 2026 00:02:00 GMT", now, 1), now + 120);
  assert.equal(retryAt(null, now, 2), now + 120);
});

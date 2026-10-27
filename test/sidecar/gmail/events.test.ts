import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { fixture, json, mail } from "./helpers.js";

type Fixture = Awaited<ReturnType<typeof fixture>>;
let current: Fixture | undefined;
afterEach(async () => { await current?.cleanup(); current = undefined; });

function poll(f: Fixture, query = "", method = "GET") {
  return fetch(`${f.endpoint}/events${query}`, { method, headers: { Authorization: `Bearer ${f.bearer}` } });
}

function record(id: string, ...messageIds: string[]) {
  return { id, messagesAdded: messageIds.map(id => ({ message: { id } })) };
}

function expectedEvent(id: string) {
  return {
    source: "gmail", externalId: id, occurredAt: 1793066400000, kind: "mail.received",
    title: "原主题", summary: "摘要  " + "字".repeat(220), actor: "sender@example.com", ref: id, labels: ["INBOX", "UNREAD"],
  };
}

describe("Gmail events HTTP", () => {
  it("初次轮询只取 profile，不回溯 history", async () => {
    const f = current = await fixture();
    const response = await poll(f);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ cursor: "100", events: [], reset: true, more: false });
    expect(f.urls.map(url => url.pathname)).toEqual(["/gmail/v1/users/me/profile"]);
    expect(f.events).toEqual([{ endpoint: "events", duration_ms: expect.any(Number), status: "ok", fetched: 0 }]);
  });

  it("两页 history 去重保序，规整事件并推进游标，审计不含邮件内容", async () => {
    const f = current = await fixture({
      history: (req, res) => {
        const page = new URL(req.url ?? "/", "http://localhost").searchParams.get("pageToken");
        json(res, page ? { historyId: "202", history: [record("102", "mail-2", "mail-3", "mail-3")] }
          : { historyId: "201", nextPageToken: "second-page", history: [record("101", "mail-1", "mail-2")] });
      },
      message: (req, res) => {
        const id = req.url?.split("/").pop()?.split("?")[0] ?? "";
        if (id === "mail-1") {
          json(res, { ...mail(id), internalDate: "1234", snippet: "摘\r\n" + "😀".repeat(510),
            labelIds: ["INBOX", "L\r\n" + "😀".repeat(80), ...Array.from({ length: 20 }, (_, i) => `label-${i}`)],
            payload: { headers: [
              { name: "sUbJeCt", value: "题\n\u0000" + "😀".repeat(210) },
              { name: "From", value: "发\r\n\t" + "人".repeat(140) },
              { name: "Date", value: "Tue, 27 Oct 2026 10:00:00 +0800" },
            ] },
          });
        } else if (id === "mail-2") json(res, { ...mail(id), internalDate: undefined });
        else json(res, { id, threadId: "thread-1", internalDate: "invalid", payload: { headers: [{ name: "Date", value: "invalid" }] } });
      },
    });
    const before = Date.now();
    const response = await poll(f, "?cursor=100&limit=3");
    const result = await response.json();
    const after = Date.now();
    expect(response.status).toBe(200);
    expect(result).toEqual({ cursor: "202", reset: false, more: false, events: [
      { ...expectedEvent("mail-1"), occurredAt: 1234, title: "题  " + "😀".repeat(197), summary: "摘  " + "😀".repeat(497),
        actor: "发   " + "人".repeat(116), labels: ["INBOX", "L  " + "😀".repeat(61), ...Array.from({ length: 14 }, (_, i) => `label-${i}`)] },
      { ...expectedEvent("mail-2"), occurredAt: Date.parse("2026-10-27T02:00:00Z") },
      { ...expectedEvent("mail-3"), occurredAt: expect.any(Number), title: "", summary: "", actor: "", labels: [] },
    ] });
    expect(result.events[2].occurredAt).toBeGreaterThanOrEqual(before);
    expect(result.events[2].occurredAt).toBeLessThanOrEqual(after);
    const history = f.urls.filter(url => url.pathname.endsWith("/history"));
    expect(history.map(url => url.searchParams.get("pageToken"))).toEqual([null, "second-page"]);
    for (const url of history) {
      expect(Object.fromEntries(url.searchParams)).toMatchObject({ startHistoryId: "100", historyTypes: "messageAdded", labelId: "INBOX", maxResults: "100" });
    }
    const messages = f.urls.filter(url => url.pathname.includes("/messages/"));
    expect(messages.map(url => url.pathname.split("/").pop())).toEqual(["mail-1", "mail-2", "mail-3"]);
    for (const url of messages) {
      expect(url.searchParams.get("format")).toBe("metadata");
      expect(url.searchParams.getAll("metadataHeaders")).toEqual(["From", "Subject", "Date"]);
    }
    expect(f.events).toEqual([{ endpoint: "events", duration_ms: expect.any(Number), status: "ok", fetched: 3 }]);
    const audit = JSON.stringify(f.events);
    for (const privateValue of ["原主题", "sender@example.com", "摘要", "mail-1", f.bearer, f.accessToken, f.refreshToken]) expect(audit).not.toContain(privateValue);
  });

  it("limit=1 按三条记录连续推进，最后返回响应 historyId", async () => {
    const records = [record("101", "mail-1"), record("102", "mail-2"), record("103", "mail-3")];
    const f = current = await fixture({ history: (req, res) => {
      const cursor = new URL(req.url ?? "/", "http://localhost").searchParams.get("startHistoryId") ?? "0";
      json(res, { historyId: "200", history: records.filter(item => BigInt(item.id) > BigInt(cursor)) });
    } });
    let cursor = "100";
    for (const [index, nextCursor] of ["101", "102", "200"].entries()) {
      const response = await poll(f, `?cursor=${cursor}&limit=1`);
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result).toEqual({ cursor: nextCursor, reset: false, more: index < 2, events: [expectedEvent(`mail-${index + 1}`)] });
      expect(f.urls.filter(url => url.pathname.includes("/messages/"))).toHaveLength(index + 1);
      cursor = result.cursor;
    }
    expect(f.urls.filter(url => url.pathname.endsWith("/history")).map(url => url.searchParams.get("startHistoryId"))).toEqual(["100", "101", "102"]);
    expect(f.urls.filter(url => url.pathname.includes("/messages/")).map(url => url.pathname)).toEqual(["mail-1", "mail-2", "mail-3"].map(id => `/gmail/v1/users/me/messages/${id}`));
    expect(f.events).toEqual(Array.from({ length: 3 }, () => ({ endpoint: "events", duration_ms: expect.any(Number), status: "ok", fetched: 1 })));
  });

  it.each([false, true])("首条记录单独超出 limit 时整条消费，有后续记录：%s", async hasMore => {
    const ids = Array.from({ length: 7 }, (_, i) => `mail-${i + 1}`);
    const f = current = await fixture({ history: (_req, res) => json(res, {
      historyId: "200", history: [record("101", ...ids, "mail-1"), ...(hasMore ? [record("102", "mail-8")] : [])],
    }) });
    expect(await (await poll(f, "?cursor=100&limit=1")).json()).toEqual({ cursor: hasMore ? "101" : "200", reset: false, more: hasMore, events: ids.map(expectedEvent) });
    expect(f.urls.filter(url => url.pathname.includes("/messages/")).map(url => url.pathname)).toEqual(ids.map(id => `/gmail/v1/users/me/messages/${id}`));
    expect(f.events).toEqual([{ endpoint: "events", duration_ms: expect.any(Number), status: "ok", fetched: 7 }]);
  });

  it("下一页记录会超限时留到下次，不截取部分邮件", async () => {
    const f = current = await fixture({ history: (req, res) => {
      const params = new URL(req.url ?? "/", "http://localhost").searchParams;
      json(res, params.has("pageToken") || params.get("startHistoryId") === "101"
        ? { historyId: "200", history: [record("102", "mail-3", "mail-4")] }
        : { historyId: "200", history: [record("101", "mail-1", "mail-2")], nextPageToken: "next" });
    } });
    expect(await (await poll(f, "?cursor=100&limit=3")).json()).toEqual({ cursor: "101", reset: false, more: true, events: [expectedEvent("mail-1"), expectedEvent("mail-2")] });
    expect(f.urls.filter(url => url.pathname.includes("/messages/"))).toHaveLength(2);
    expect(await (await poll(f, "?cursor=101&limit=3")).json()).toEqual({ cursor: "200", reset: false, more: false, events: [expectedEvent("mail-3"), expectedEvent("mail-4")] });
    expect(f.urls.filter(url => url.pathname.includes("/messages/")).map(url => url.pathname)).toEqual(["mail-1", "mail-2", "mail-3", "mail-4"].map(id => `/gmail/v1/users/me/messages/${id}`));
  });

  it("达到 limit 后有后页时返回末条记录游标，不继续读取", async () => {
    const f = current = await fixture({ history: (_req, res) => {
      json(res, { historyId: "12345678901234567899", history: [record("12345678901234567890", "mail-1")], nextPageToken: "next" });
    } });
    expect(await (await poll(f, "?cursor=100&limit=1")).json()).toEqual({ cursor: "12345678901234567890", reset: false, more: true, events: [expectedEvent("mail-1")] });
    expect(f.urls.filter(url => url.pathname.endsWith("/history"))).toHaveLength(1);
  });

  it("已消费空记录时也推进游标，后续超限记录留到下一轮整条消费", async () => {
    const f = current = await fixture({ history: (req, res) => {
      const cursor = new URL(req.url ?? "/", "http://localhost").searchParams.get("startHistoryId");
      json(res, { historyId: "200", history: [...(cursor === "100" ? [{ id: "101" }] : []), record("102", "mail-1", "mail-2")] });
    } });
    expect(await (await poll(f, "?cursor=100&limit=1")).json()).toEqual({ cursor: "101", reset: false, more: true, events: [] });
    expect(f.urls.filter(url => url.pathname.includes("/messages/"))).toHaveLength(0);
    expect(await (await poll(f, "?cursor=101&limit=1")).json()).toEqual({ cursor: "200", reset: false, more: false, events: [expectedEvent("mail-1"), expectedEvent("mail-2")] });
  });

  it.each([undefined, "", "abc", "123456789012345678901"])("history 记录 id 缺失或格式错误返回 response：%s", async id => {
    const f = current = await fixture({ history: (_req, res) => json(res, { historyId: "200", history: [{ id, messagesAdded: [] }] }) });
    const response = await poll(f, "?cursor=100");
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "response" });
  });

  it("history 404 重新取 profile，成功审计标记 history_reset", async () => {
    const f = current = await fixture({ history: (_req, res) => json(res, { error: "private history diagnostic" }, 404) });
    const response = await poll(f, "?cursor=1");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cursor: "100", reset: true, more: false, events: [] });
    expect(f.urls.map(url => url.pathname)).toEqual(["/gmail/v1/users/me/history", "/gmail/v1/users/me/profile"]);
    expect(f.events).toEqual([{ endpoint: "events", duration_ms: expect.any(Number), status: "ok", fetched: 0, error: "history_reset" }]);
  });

  it("无/错 Bearer 不读请求体、不调用 Google，并各记一行审计", async () => {
    const f = current = await fixture();
    for (const authorization of [undefined, "Bearer incorrect"]) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(`${f.endpoint}/events?cursor=abc`, { method: "GET", headers: {
          "Content-Length": "500000", ...(authorization ? { Authorization: authorization } : {}),
        } }, res => { resolve(res.statusCode); res.resume(); req.destroy(); });
        req.on("error", reject);
        req.flushHeaders();
      });
      expect(status).toBe(401);
    }
    expect(f.gmailCalls).toBe(0);
    expect(f.tokenCalls).toBe(0);
    expect(f.events).toEqual(Array.from({ length: 2 }, () => ({ endpoint: "events", duration_ms: expect.any(Number), status: "error", fetched: 0, error: "unauthorized" })));
  });

  it("拒绝非法 cursor、limit 和非 GET 方法", async () => {
    const f = current = await fixture();
    const queries = ["cursor=abc", "cursor=", "cursor=-1", "cursor=123456789012345678901", "limit=", "limit=0", "limit=51", "limit=-1", "limit=1.5", "limit=1e1", "limit=%20", "limit=Infinity"];
    for (const query of queries) {
      const response = await poll(f, `?${query}`);
      expect(response.status, query).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: "input" });
    }
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      const response = await poll(f, "", method);
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow")).toBe("GET");
    }
    expect(f.gmailCalls).toBe(0);
    expect(f.tokenCalls).toBe(0);
    expect(f.events).toHaveLength(queries.length + 6);
  });

  it("邮件元数据 404 只跳过已删邮件，游标正常推进", async () => {
    const f = current = await fixture({
      history: (_req, res) => json(res, { historyId: "200", history: [record("101", "mail-1", "deleted", "mail-3")] }),
      message: (req, res) => {
        const id = req.url?.split("/").pop()?.split("?")[0] ?? "";
        if (id === "deleted") json(res, { error: "private deleted diagnostic" }, 404);
        else json(res, mail(id));
      },
    });
    const response = await poll(f, "?cursor=100");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cursor: "200", reset: false, more: false, events: [expectedEvent("mail-1"), expectedEvent("mail-3")] });
    expect(f.urls.some(url => url.pathname.endsWith("/profile"))).toBe(false);
    expect(f.events).toEqual([{ endpoint: "events", duration_ms: expect.any(Number), status: "ok", fetched: 2 }]);
  });

  it.each([false, true])("history 最多十页，第十页仍有后页时返回末条记录游标：%s", async hasMore => {
    let pages = 0;
    const f = current = await fixture({ history: (_req, res) => {
      pages++;
      json(res, { historyId: "999", history: [record(String(100 + pages), `mail-${pages}`)], ...(hasMore || pages < 10 ? { nextPageToken: `page-${pages + 1}` } : {}) });
    } });
    expect(await (await poll(f, "?cursor=100")).json()).toEqual({ cursor: hasMore ? "110" : "999", reset: false, more: hasMore, events: Array.from({ length: 10 }, (_, i) => expectedEvent(`mail-${i + 1}`)) });
    expect(pages).toBe(10);
    expect(f.urls.filter(url => url.pathname.endsWith("/history")).map(url => url.searchParams.get("pageToken"))).toEqual([null, ...Array.from({ length: 9 }, (_, i) => `page-${i + 2}`)]);
  });

  it("十页都没有记录且仍有后页时保留输入游标", async () => {
    const f = current = await fixture({ history: (_req, res) => json(res, { historyId: "200", nextPageToken: "next" }) });
    expect(await (await poll(f, "?cursor=100")).json()).toEqual({ cursor: "100", reset: false, more: true, events: [] });
    expect(f.urls).toHaveLength(10);
  });

  it.each([["", 20], ["&limit=50", 50]])("默认/最大 limit 限制元数据数且并发不超过五：%s", async (query, count) => {
    let active = 0, peak = 0;
    const ids = Array.from({ length: 51 }, (_, i) => `mail-${i + 1}`);
    const f = current = await fixture({
      history: (_req, res) => json(res, { historyId: "200", history: ids.map((id, index) => record(String(101 + index), id)) }),
      message: async (req, res) => {
        active++;
        peak = Math.max(peak, active);
        const id = req.url?.split("/").pop()?.split("?")[0] ?? "";
        await delay(id.endsWith("1") ? 20 : 5);
        active--;
        json(res, mail(id));
      },
    });
    expect(await (await poll(f, `?cursor=100${query}`)).json()).toEqual({ cursor: String(100 + Number(count)), reset: false, more: true, events: ids.slice(0, Number(count)).map(expectedEvent) });
    expect(f.urls.filter(url => url.pathname.includes("/messages/"))).toHaveLength(Number(count));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(5);
    expect(active).toBe(0);
  });

  it("没有新增时仍返回最新游标，保留二十位游标精度", async () => {
    const f = current = await fixture();
    expect(await (await poll(f, "?cursor=12345678901234567890")).json()).toEqual({ cursor: "101", reset: false, more: false, events: [] });
    expect(f.urls[0].searchParams.get("startHistoryId")).toBe("12345678901234567890");
  });

  it.each([[401, "unauthorized"], [403, "permission"], [429, "quota"], [500, "upstream"]])("Google %s 错误只返回分类", async (status, kind) => {
    const f = current = await fixture({ history: (_req, res) => json(res, { error: "private upstream diagnostic" }, Number(status)) });
    const response = await poll(f, "?cursor=100");
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: kind });
    expect(f.events).toEqual([{ endpoint: "events", duration_ms: expect.any(Number), status: "error", fetched: 0, error: kind }]);
  });

  it("元数据非 404 错误整体失败，不重置 history", async () => {
    const f = current = await fixture({
      history: (_req, res) => json(res, { historyId: "200", history: [record("101", "mail-1")] }),
      message: (_req, res) => json(res, { error: "private metadata diagnostic" }, 403),
    });
    const response = await poll(f, "?cursor=100");
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "permission" });
    expect(f.urls.some(url => url.pathname.endsWith("/profile"))).toBe(false);
    expect(f.events).toHaveLength(1);
  });

  it("重置时 profile 失败保留错误分类，畸形成功响应归为 response", async () => {
    let calls = 0;
    const f = current = await fixture({
      history: (_req, res) => json(res, {}, 404),
      profile: (_req, res) => { calls++; json(res, { error: "private profile diagnostic" }, calls === 1 ? 500 : 200); },
    });
    for (const kind of ["upstream", "response"]) {
      const response = await poll(f, "?cursor=100");
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: kind });
    }
    expect(f.events).toEqual(["upstream", "response"].map(error => ({ endpoint: "events", duration_ms: expect.any(Number), status: "error", fetched: 0, error })));
  });

  it.each([true, false])("授权缺失或失效返回 503：missing=%s", async missing => {
    const f = current = await fixture({ missing, expiresInMs: 0, token: (_req, res) => json(res, { error: "invalid_grant", error_description: "private auth diagnostic" }, 400) });
    const response = await poll(f);
    const error = missing ? "auth_missing" : "auth_invalid";
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error });
    expect(f.gmailCalls).toBe(0);
    expect(f.events).toEqual([{ endpoint: "events", duration_ms: expect.any(Number), status: "error", fetched: 0, error }]);
  });
});

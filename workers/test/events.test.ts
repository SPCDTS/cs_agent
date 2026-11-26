import { createExecutionContext, createScheduledController, env, reset, runDurableObjectAlarm, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import worker from "../src/index";
import { EventsDO } from "../src/events/do";
import { DEFAULT_SETTINGS, type SourceSettings } from "../src/events/model";
import { DEFAULT_GITHUB } from "../src/github/model";
import { ThreadMcp } from "../src/mcp";
import { MCP_CATALOG_SCHEMA } from "../src/mcp/catalog";
import { MCP_CONFIG, parseMcpConfig } from "../src/mcp/config";
import config from "./fixtures/mcp.json";
import { threadWithBindings } from "./thread-fixture";
import { fakeGoogle, scriptedModel, sql } from "./events-helpers";
import { fakeRemote, login } from "./mcp-helpers";
import { action, adminHealth, connect, input, reply } from "./helpers";

describe("events polling and delivery", () => {
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await reset();
    vi.restoreAllMocks();
  });
  const events = () => env.EVENTS.getByName("main");
  const settings = (patch: Partial<SourceSettings>) => events().putSettings("gmail", { ...DEFAULT_SETTINGS, ...patch });
  type Held = { key: string; reason: string; received_at: number };
  type Run = { input_key: string; keys_json: string; status: string };
  const inbound = () => runInDurableObject(env.THREAD.getByName("owner"), (_instance, state) =>
    state.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'inbound'").toArray().length
      ? state.storage.sql.exec<{ message_id: string; text: string; kind: string; status: string }>("SELECT message_id, text, kind, status FROM inbound ORDER BY rowid").toArray() : []);
  const beijing = (offsetMinutes: number) => new Date(Date.now() + 8 * 3_600_000 + offsetMinutes * 60_000).toISOString().slice(11, 16);
  
  describe("EventsDO Gmail polling", () => {
    it("starts from the current historyId without replaying the mailbox, and renews the watch when a topic is set", async () => {
      const google = fakeGoogle();
      google.addMail("old-1");
      await runInDurableObject(events(), async (_instance, state) => {
        await new EventsDO(state, { ...env, GMAIL_PUBSUB_TOPIC: "projects/proj-test/topics/gmail-push" }).poll("gmail");
      });
      expect(await sql("SELECT cursor FROM event_source WHERE id='gmail'")).toEqual([{ cursor: "101" }]);
      expect(await sql("SELECT key FROM event_held")).toEqual([]);
      expect(google.state.requests.some(line => line.includes("/history?"))).toBe(false);
      expect(google.state.watches).toBe(1);
      expect((await sql<{ expiration: number }>("SELECT expiration FROM gmail_watch"))[0]?.expiration).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    });
  
    it("resets the cursor on 404, consumes history records whole across pages, and skips vanished messages", async () => {
      const google = fakeGoogle();
      await events().poll("gmail");
      await settings({ mergeWindowS: 600, budgetPerHour: 100 });
      for (let i = 0; i < 49; i++) google.addMail(`m${i}`);
      const split = google.state.historyId;
      google.addMail("x1", {}, false); google.addMail("x2", {}, false); google.addMail("x3", {}, false);
      google.state.history.push({ id: google.state.historyId, messages: ["x1", "x2", "x3"] });
      google.addMail("gone"); google.state.missing.add("gone");
      await events().notify("gmail");
      // 第二页从被拆开前的最后一条整记录继续，三封邮件的那条记录完整留到下一次。
      const starts = google.state.requests.filter(line => line.includes("/history?")).map(line => new URL(line.slice(4)).searchParams.get("startHistoryId"));
      expect(starts).toEqual(["100", String(split)]);
      expect(await sql<Held>("SELECT key FROM event_held")).toHaveLength(52);
      expect(await sql("SELECT cursor FROM event_source WHERE id='gmail'")).toEqual([{ cursor: String(google.state.historyId) }]);
  
      google.state.historyStatus = 404;
      google.addMail("lost");
      await events().notify("gmail");
      expect(await sql("SELECT cursor FROM event_source WHERE id='gmail'")).toEqual([{ cursor: String(google.state.historyId) }]);
      expect(await sql("SELECT key FROM event_held")).toHaveLength(52);
    });
  
    it("keeps at most 200 held events, dropping the oldest and alerting", async () => {
      const google = fakeGoogle();
      const { frames } = await connect(sockets);
      await events().poll("gmail");
      await settings({ mergeWindowS: 600 });
      for (let i = 0; i < 205; i++) google.addMail(`bulk${i}`);
      await events().notify("gmail");
      const held = await sql<{ event_json: string }>("SELECT event_json FROM event_held ORDER BY received_at, rowid");
      expect(held).toHaveLength(200);
      expect(JSON.parse(held[0]!.event_json).externalId).toBe("bulk5");
      expect((await action(frames, 0, "send_private_msg")).params.message?.[0]?.data.text).toContain("丢弃最旧的 5 件");
    });
  
    it("marks the source degraded after three failed polls and alerts the owner once", async () => {
      const google = fakeGoogle();
      const { frames, socket } = await connect(sockets);
      await events().poll("gmail");
      google.state.failGmail = true;
      for (let i = 0; i < 4; i++) await events().notify("gmail");
      expect(await sql("SELECT failures, degraded, last_error_code FROM event_source WHERE id='gmail'")).toEqual([{ failures: 4, degraded: 1, last_error_code: "upstream" }]);
      const alert = await action(frames, 0, "send_private_msg");
      expect(alert.params.user_id).toBe("10000001");
      expect(alert.params.message?.[0]?.data.text).toContain("连续 3 次拉取失败");
      socket.send(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 1 }, echo: alert.echo }));
      expect(frames.filter(frame => JSON.stringify(frame).includes("send_private_msg"))).toHaveLength(1);
      expect(JSON.stringify(await events().health())).toContain('"degraded":true');
    });
  });
  
  describe("EventsDO delivery pipeline", () => {
    it("merges events within the window into one owner input delivered by the alarm, and deduplicates repeats", async () => {
      const google = fakeGoogle();
      await events().poll("gmail");
      google.addMail("a"); google.addMail("promo", { labels: ["INBOX", "CATEGORY_PROMOTIONS"] }); google.addMail("b");
      await events().notify("gmail");
      expect(await sql<Held>("SELECT reason FROM event_held")).toEqual([{ reason: "merge" }, { reason: "merge" }]);
      expect(await inbound()).toEqual([]);
      const alarm = await runInDurableObject(events(), (_instance, state) => state.storage.getAlarm());
      expect(alarm).toBeGreaterThan(Date.now() + 50_000);
  
      await sql("UPDATE event_held SET received_at = received_at - 61000");
      expect(await runDurableObjectAlarm(events())).toBe(true);
      const runs = await sql<Run>("SELECT * FROM event_run");
      expect(runs).toHaveLength(1);
      expect(JSON.parse(runs[0]!.keys_json)).toHaveLength(2);
      const [row] = await inbound();
      expect(row).toMatchObject({ kind: "event", message_id: runs[0]!.input_key });
      expect(row?.text).toContain("[外部事件] gmail · 新邮件 2 件");
      expect(row?.text).toContain("ref=a · Alice <alice@example.test> · 主题：主题 a");
      expect(row?.text).not.toContain("promo");
      expect(await sql("SELECT key FROM event_held")).toEqual([]);
      await vi.waitFor(async () => expect((await sql<Run>("SELECT status FROM event_run"))[0]?.status).toBe("silent"), { timeout: 10_000 });
  
      google.state.history.push({ id: ++google.state.historyId, messages: ["a"] });
      await events().notify("gmail");
      expect(await sql("SELECT key FROM event_held")).toEqual([]);
      expect(await sql("SELECT 1 FROM event_run")).toHaveLength(1);
    });
  
    it("holds events during quiet hours and delivers them on the alarm after the window ends", async () => {
      const google = fakeGoogle();
      await events().poll("gmail");
      await settings({ quietHours: { start: beijing(-60), end: beijing(60) } });
      google.addMail("night");
      await events().notify("gmail");
      expect(await sql<Held>("SELECT reason FROM event_held")).toEqual([{ reason: "quiet" }]);
      const alarm = await runInDurableObject(events(), (_instance, state) => state.storage.getAlarm());
      expect(alarm).toBeGreaterThan(Date.now() + 58 * 60_000);
      expect(alarm).toBeLessThanOrEqual(Date.now() + 60 * 60_000);
  
      await sql("UPDATE event_source SET settings_json = ? WHERE id='gmail'", JSON.stringify({ ...DEFAULT_SETTINGS, quietHours: { start: beijing(-120), end: beijing(-60) } }));
      await sql("UPDATE event_held SET received_at = received_at - 61000");
      await runDurableObjectAlarm(events());
      expect(await sql("SELECT key FROM event_held")).toEqual([]);
      expect((await inbound())[0]?.text).toContain("主题：主题 night");
      // 投递返回时 Thread 仍在后台结算，等它完成后才能重置存储，避免串入下一用例。
      await vi.waitFor(async () => expect(await sql("SELECT 1 FROM event_run WHERE status = 'queued'")).toEqual([]), { timeout: 10_000 });
    });
  
    it("folds events over the hourly budget into the next input as an unexpanded count", async () => {
      const google = fakeGoogle();
      await events().poll("gmail");
      await settings({ mergeWindowS: 0, budgetPerHour: 1 });
      google.addMail("first");
      await events().notify("gmail");
      google.addMail("over-1"); google.addMail("over-2");
      await events().notify("gmail");
      expect(await sql<Held>("SELECT reason FROM event_held")).toEqual([{ reason: "budget" }, { reason: "budget" }]);
      expect(await inbound()).toHaveLength(1);
  
      await sql("UPDATE event_run SET delivered_at = delivered_at - 3600001");
      google.addMail("next");
      await events().notify("gmail");
      const rows = await inbound();
      expect(rows).toHaveLength(2);
      expect(rows[1]?.text).toContain("新邮件 1 件");
      expect(rows[1]?.text).toContain("主题：主题 next");
      expect(rows[1]?.text).not.toContain("over-1");
      expect(rows[1]?.text).toContain("[另有 2 件未展开]");
      const runs = await sql<Run>("SELECT keys_json FROM event_run ORDER BY rowid");
      expect(JSON.parse(runs[1]!.keys_json)).toHaveLength(3);
      // 投递返回时 Thread 仍在后台结算，等它完成后才能重置存储，避免串入下一用例。
      await vi.waitFor(async () => expect(await sql("SELECT 1 FROM event_run WHERE status = 'queued'")).toEqual([]), { timeout: 10_000 });
    });
  
    it("pauses the source after three failed event turns and alerts once", async () => {
      await sql("INSERT INTO event_run (input_key, source, keys_json, delivered_at, status) VALUES ('k1','gmail','[]',1,'queued'),('k2','gmail','[]',2,'queued'),('k3','gmail','[]',3,'queued')");
      await events().finishRun("k1", "failed");
      await events().finishRun("k2", "failed");
      expect(await sql("SELECT paused FROM event_source WHERE id='gmail'")).toEqual([{ paused: 0 }]);
      await events().finishRun("k3", "failed");
      expect(await sql("SELECT paused, pause_reason FROM event_source WHERE id='gmail'")).toEqual([{ paused: 1, pause_reason: "turn_failures" }]);
      expect(await sql("SELECT status FROM event_run ORDER BY rowid")).toEqual([{ status: "failed" }, { status: "failed" }, { status: "failed" }]);
  
      expect(await events().setPaused("gmail", false)).toBe(true);
      await sql("INSERT INTO event_run (input_key, source, keys_json, delivered_at, status) VALUES ('k4','gmail','[]',4,'queued')");
      await events().finishRun("k4", "failed");
      expect(await sql("SELECT paused FROM event_source WHERE id='gmail'")).toEqual([{ paused: 0 }]);
    });
  });
});

describe("events push cron and admin endpoints", () => {
  afterEach(async () => { await reset(); vi.restoreAllMocks(); });
  // 测试内生成的 RSA 密钥对冒充 Google 的签名密钥，不访问真实 JWKS。
  const ACCOUNT = "gmail-push@proj-test.iam.gserviceaccount.com", audience = `${env.PUBLIC_ORIGIN}/gmail/pubsub`;
  let signing: CryptoKeyPair, impostor: CryptoKeyPair, jwks: unknown;
  const algorithm = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  beforeAll(async () => {
    signing = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]) as CryptoKeyPair;
    impostor = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]) as CryptoKeyPair;
    jwks = { keys: [{ ...await crypto.subtle.exportKey("jwk", signing.publicKey), kid: "push-kid", alg: "RS256", use: "sig" }] };
  });
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  async function token(claims: Record<string, unknown> = {}, key = signing.privateKey) {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64({ alg: "RS256", kid: "push-kid", typ: "JWT" })}.${b64({ iss: "https://accounts.google.com", aud: audience, email: ACCOUNT, email_verified: true, iat: now, exp: now + 3600, ...claims })}`;
    return `${unsigned}.${Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned))).toString("base64url")}`;
  }
  function push(bearer: string, body: unknown = { message: { data: Buffer.from(JSON.stringify({ emailAddress: "owner@example.test", historyId: 4242 })).toString("base64"), messageId: "m-1" }, subscription: "projects/proj-test/subscriptions/gmail" }) {
    return new Request(audience, { method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }
  async function call(request: Request, overrides: Record<string, string> = { GMAIL_PUBSUB_SERVICE_ACCOUNT: ACCOUNT }) {
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, { ...env, ...overrides }, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }
  
  describe("Pub/Sub push endpoint", () => {
    it("rejects wrong audience, email, issuer, expiry, signature, and a disabled endpoint with 403", async () => {
      const google = fakeGoogle(); google.state.jwks = jwks;
      const now = Math.floor(Date.now() / 1000);
      for (const bearer of [
        await token({ aud: "https://agent.spcdts.dev/other" }), await token({ email: "someone@example.test" }),
        await token({ iss: "https://evil.example.test" }), await token({ exp: now - 1 }), await token({ email_verified: false }),
        await token({}, impostor.privateKey), "not-a-jwt",
      ]) expect((await call(push(bearer))).status).toBe(403);
      expect((await call(push(await token()), { GMAIL_PUBSUB_SERVICE_ACCOUNT: "" })).status).toBe(403);
      expect(google.state.requests.some(line => line.includes("gmail.googleapis.com"))).toBe(false);
    });
  
    it("acknowledges a valid push with 204 and polls Gmail in the background", async () => {
      const google = fakeGoogle(); google.state.jwks = jwks;
      const response = await call(push(await token()));
      expect(response.status).toBe(204);
      expect(google.state.requests.some(line => line.endsWith("/gmail/v1/users/me/profile"))).toBe(true);
      expect(await sql("SELECT cursor FROM event_source WHERE id='gmail'")).toEqual([{ cursor: "100" }]);
      expect((await call(push(await token(), { message: { data: "bm90IGpzb24=", messageId: "m-2" }, subscription: "s" }))).status).toBe(400);
      expect((await call(push(await token(), { padding: "x".repeat(70_000) }))).status).toBe(400);
    });
  });
  
  describe("cron dispatch", () => {
    it("polls Gmail on the five-minute cron, honours intervalS, and ignores unknown crons", async () => {
      const google = fakeGoogle();
      const tick = async (cron: string) => {
        const ctx = createExecutionContext();
        await worker.scheduled(createScheduledController({ cron, scheduledTime: Date.now() }), env, ctx);
        await waitOnExecutionContext(ctx);
      };
      await tick("0 3 * * *");
      expect(google.state.requests).toEqual([]);
      await tick("*/5 * * * *");
      expect(await sql("SELECT cursor FROM event_source WHERE id='gmail'")).toEqual([{ cursor: "100" }]);
      const before = google.state.requests.length;
      await tick("*/5 * * * *");
      expect(google.state.requests).toHaveLength(before);
    });
  });
  
  describe("event admin endpoints", () => {
    const admin = (path: string, init: RequestInit = {}, bearer = "synthetic-admin") =>
      worker.fetch(new Request(`${env.PUBLIC_ORIGIN}${path}`, { ...init, headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" } }), { ...env, ADMIN_TOKEN: "synthetic-admin" });
  
    it("requires the admin token, pauses and resumes, and validates settings strictly", async () => {
      expect((await admin("/admin/event-sources", {}, "wrong")).status).toBe(401);
      const status = await (await admin("/admin/event-sources")).json();
      expect(status).toMatchObject({ sources: [{ id: "gmail", configured: true, paused: false, held: 0, budget: { used: 0, perHour: 10 }, settings: DEFAULT_SETTINGS }, { id: "github", configured: true, paused: false, settings: DEFAULT_GITHUB.settings }], runs: [] });
  
      // The shared fixture configures the App transport, not an owner identity or repository grant.
      expect(status).toMatchObject({github:{value:{repositoryIds:[]},connections:{identities:[],installations:[]}}});
  
      expect((await admin("/admin/event-sources/gmail/pause", { method: "POST" })).status).toBe(200);
      expect(await env.EVENTS.getByName("main").health()).toMatchObject({ sources: [{ id: "gmail", paused: true }, { id: "github", paused: false, enabled: true }], held: 0 });
      expect((await admin("/admin/event-sources/gmail/resume", { method: "POST" })).status).toBe(200);
      expect((await admin("/admin/event-sources/calendar/pause", { method: "POST" })).status).toBe(404);
  
      const put = (body: unknown, source = "gmail") => admin(`/admin/event-sources/${source}/settings`, { method: "PUT", body: JSON.stringify(body) });
      expect((await put({ ...DEFAULT_SETTINGS, intervalS: 5 })).status).toBe(400);
      expect((await put({ ...DEFAULT_SETTINGS, filters: { ...DEFAULT_SETTINGS.filters, extra: [] } })).status).toBe(400);
      expect((await put(DEFAULT_SETTINGS, "calendar")).status).toBe(404);
      const quiet = { ...DEFAULT_SETTINGS, quietHours: { start: "23:00", end: "08:00" } };
      expect((await put(quiet)).status).toBe(200);
      expect(await (await admin("/admin/event-sources")).json()).toMatchObject({ sources: [{ id: "gmail", paused: false, settings: quiet }, { id: "github", paused: false, settings: DEFAULT_GITHUB.settings }] });
  
      const health = await (await adminHealth()).json();
      expect(health).toMatchObject({ events: { sources: [{ id: "gmail", enabled: true, paused: false, degraded: false, cursor: false, lastPollAt: null }, { id: "github", enabled: true, paused: false, cursor: false }], held: 0 } });
    });
  });
});

describe("events owner turns and gmail tools", () => {
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await reset();
    vi.restoreAllMocks();
  });
  const events = () => env.EVENTS.getByName("main");
  const status = async () => (await sql<{ status: string }>("SELECT status FROM event_run"))[0]?.status;
  const inboundRow = (key: string) => runInDurableObject(env.THREAD.getByName("owner"), (_instance, state) =>
    state.storage.sql.exec<{ status: string; when_busy: string | null }>("SELECT status, when_busy FROM inbound WHERE message_id = ?", key).toArray()[0]);
  async function deliverMail(google: ReturnType<typeof fakeGoogle>, id: string) {
    await events().poll("gmail");
    await events().putSettings("gmail", { ...DEFAULT_SETTINGS, mergeWindowS: 0 });
    google.addMail(id, { subject: "Q4 预算确认", body: "请在周五前确认预算。" });
    await events().notify("gmail");
  }
  const EVENT_TOOLS = ["send_message", "qq_context", "mem_search", "gmail_search", "gmail_read", "web_page", "read_skill"];
  const WRITE_TOOLS = ["mem_remember", "mem_update", "mem_forget", "mem_profile", "gmail_send"];
  const SANDBOX_TOOLS = ["read", "write", "edit", "bash"];
  
  describe("event turns in the owner thread", () => {
    it("runs a read-only triage turn, records sent, and restores the full tool set for the next owner message", async () => {
      const { socket, frames } = await connect(sockets);
      const google = fakeGoogle();
      const seen = scriptedModel([
        { name: "gmail_read", args: { id: "a" } },
        { name: "gmail_send", args: { to: "bob@example.test", subject: "x", text: "y", idempotencyKey: "event-attempt-1" } },
        { name: "send_message", args: { text: "有一封预算确认邮件需要你周五前处理。" } },
        { name: "", args: {} },
        { name: "mem_search", args: {} },
      ]);
      await deliverMail(google, "a");
      reply(socket, (await action(frames, 0, "send_private_msg")).echo);
      await vi.waitFor(async () => expect(await status()).toBe("sent"), { timeout: 10_000 });
  
      const first = seen.requests[0]!;
      expect(first.user).toContain("[外部事件] gmail · 新邮件 1 件");
      expect(first.tools).toEqual(expect.arrayContaining(EVENT_TOOLS));
      for (const name of [...WRITE_TOOLS, ...SANDBOX_TOOLS, "generate_image"]) expect(first.tools).not.toContain(name);
      expect(seen.outputs[0]).toContain("请在周五前确认预算。");
      expect(seen.outputs[0]).toContain("report.pdf | 2048 bytes");
      expect(google.state.sends).toBe(0);
      expect(seen.outputs[1]).not.toContain("已发送");
  
      expect(await env.THREAD.getByName("owner").submit(input(2, "好的，记一下", 10000001))).toEqual({ status: "done" });
      const chat = seen.requests.find(request => request.user.includes("好的，记一下"));
      expect(chat?.tools).toEqual(expect.arrayContaining([...EVENT_TOOLS, ...WRITE_TOOLS, "codemode"]));
      for (const name of SANDBOX_TOOLS) expect(chat?.tools).not.toContain(name);
      expect(chat?.tools).toContain("generate_image");
      const messages = await runInDurableObject(env.THREAD.getByName("owner"), (_instance, state) =>
        state.storage.sql.exec<{ text: string }>("SELECT text FROM messages").toArray().map(row => row.text).join("\n"));
      expect(messages).not.toContain("Q4 预算确认");
    });
  
    it("queues an event behind the running owner turn instead of steering into it", async () => {
      const { socket, frames } = await connect(sockets);
      const google = fakeGoogle();
      const seen = scriptedModel([{ name: "send_message", args: { text: "处理中" } }, { name: "", args: {} }]);
      const turn = env.THREAD.getByName("owner").submit(input(3, "帮我看看", 10000001));
      const held = await action(frames, 0, "send_private_msg");
      await deliverMail(google, "late");
      const [run] = await sql<{ input_key: string }>("SELECT input_key FROM event_run");
      expect(await inboundRow(run!.input_key)).toEqual({ status: "queued", when_busy: null });
  
      reply(socket, held.echo);
      expect(await turn).toEqual({ status: "done" });
      await vi.waitFor(async () => expect(await status()).toBe("silent"), { timeout: 10_000 });
      expect(await inboundRow(run!.input_key)).toEqual({ status: "done", when_busy: "followUp" });
      const event = seen.requests.find(request => request.user.includes("[外部事件]"));
      expect(event?.tools).not.toContain("mem_remember");
    });
  });
  
  describe("Gmail tools", () => {
    it("searches, then sends once per idempotencyKey in an owner message turn", async () => {
      const google = fakeGoogle();
      google.addMail("budget-1", { subject: "预算\n确认", snippet: "请确认" });
      const draft = { to: "Bob <bob@example.test>", subject: "回复：预算", text: "已确认。", inReplyTo: "budget-1", idempotencyKey: "reply-budget-0001" };
      const seen = scriptedModel([{ name: "gmail_search", args: { q: "预算", maxResults: 5 } }, { name: "gmail_send", args: draft }, { name: "gmail_send", args: draft }]);
      expect(await env.THREAD.getByName("owner").submit(input(4, "回他已确认", 10000001))).toEqual({ status: "done" });
      expect(seen.outputs[0]).toBe("budget-1 | Tue, 27 Oct 2026 08:18:00 +0000 | Alice <alice@example.test> | 预算 确认\n  请确认");
      expect(google.state.sends).toBe(1);
      expect(seen.outputs[1]).toContain("已发送 messageId=sent-1");
      expect(seen.outputs[2]).toContain("未再次发送");
      expect(await sql("SELECT key, message_id FROM gmail_send_receipts")).toEqual([{ key: draft.idempotencyKey, message_id: "sent-1" }]);
    });
  
    it.each([
      { ns: "group:200000001", value: input(5, "查邮件", 10000003, 200000001, true) },
      { ns: "private:10000003", value: input(6, "查邮件", 10000003) },
    ])("does not offer Gmail tools in $ns", async ({ ns, value }) => {
      fakeGoogle();
      const seen = scriptedModel([]);
      await runInDurableObject(env.THREAD.getByName(ns), async (_instance, state) => {
        expect(await threadWithBindings(_instance, state, { ...env, MEMORY_EXTRACT_NAMESPACES: "" }).submit(value)).toEqual({ status: "done" });
      });
      expect(seen.requests[0]?.tools.some(name => name.startsWith("gmail_"))).toBe(false);
    });
  });
});

describe("events mcp allow", () => {
  afterEach(async () => { await reset(); vi.restoreAllMocks(); });
  const text = (result: { output?: readonly unknown[] }) => JSON.stringify(result.output);
  
  describe("MCP eventAllow", () => {
    it("must be a subset of allow and defaults to empty; Notion opens search and fetch to event turns", () => {
      const server = config.servers[0]!;
      expect(() => parseMcpConfig({ ...config, servers: [{ ...server, tools: { allow: ["notion-search"], eventAllow: ["notion-create-pages"] } }] })).toThrow("mcp_config_invalid");
      expect(parseMcpConfig({ ...config, servers: [{ ...server, tools: { allow: ["notion-search"] } }] }).servers[0]?.tools.eventAllow).toEqual([]);
      expect(MCP_CONFIG.servers[0]?.tools.eventAllow).toEqual(["notion-search", "notion-fetch"]);
    });
  
    it("lets event turns call only eventAllow tools and never refresh the catalog", async () => {
      const remote = fakeRemote(); await login();
      let kind: "message" | "event" = "event";
      await runInDurableObject(env.THREAD.getByName("owner"), async (_instance, state) => {
        const db = new DurableObjectSqliteDatabase(state.storage);
        await db.exec(MCP_CATALOG_SCHEMA + "CREATE TABLE IF NOT EXISTS events(at INTEGER,kind TEXT,detail TEXT)");
        const server = { ...MCP_CONFIG.servers[0]!, tools: { allow: ["notion-search", "notion-fetch"], eventAllow: ["notion-search"] } };
        const registry = createRegistry(), mcp = new ThreadMcp(db, env, registry, async () => kind, { ...MCP_CONFIG, servers: [server] });
        await mcp.refreshAll();
        const tool = (prefix: string) => registry.snapshot().tools().map(entry => entry.tool).find(candidate => candidate.name.startsWith(prefix))!;
        const api = {} as ToolExecutionApi;
        expect(text(await tool("mcp_notion_notion_search").execute({ query: "q" }, api, BACKGROUND_CONTEXT))).toContain("service-result");
        expect(text(await tool("mcp_notion_notion_fetch").execute({}, api, BACKGROUND_CONTEXT))).toContain("denied");
        expect(text(await tool("mcp_refresh_tools").execute({}, api, BACKGROUND_CONTEXT))).toContain("denied");
        kind = "message";
        expect(text(await tool("mcp_notion_notion_fetch").execute({}, api, BACKGROUND_CONTEXT))).toContain("service-result");
        await mcp.close();
      });
      expect(remote.state.calls).toBe(2);
    });
  });
});

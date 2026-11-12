import { DEFAULT_GITHUB } from "../src/github/model";
import { adminHealth } from "./helpers";
import { createExecutionContext, createScheduledController, env, reset, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { DEFAULT_SETTINGS } from "../src/events/model";
import { fakeGoogle, sql } from "./events-helpers";

afterEach(async () => { vi.restoreAllMocks(); await reset(); });
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
    expect(status).toMatchObject({ sources: [{ id: "gmail", configured: true, paused: false, held: 0, budget: { used: 0, perHour: 10 }, settings: DEFAULT_SETTINGS }, { id: "github", configured: false, paused: false, settings: DEFAULT_GITHUB.settings }], runs: [] });

    expect((await admin("/admin/event-sources/gmail/pause", { method: "POST" })).status).toBe(200);
    expect(await env.EVENTS.getByName("main").health()).toMatchObject({ sources: [{ id: "gmail", paused: true }, { id: "github", paused: false, enabled: false }], held: 0 });
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
    expect(health).toMatchObject({ events: { sources: [{ id: "gmail", enabled: true, paused: false, degraded: false, cursor: false, lastPollAt: null }, { id: "github", enabled: false, paused: false, cursor: false }], held: 0 } });
  });
});

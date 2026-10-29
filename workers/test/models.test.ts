import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModels } from "@earendil-works/pi-ai/models";
import type { Credential } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import worker from "../src/index";
import * as models from "../src/models";
import { remoteCredentials } from "../src/model-credentials";
import { RegistryDO, type ModelView } from "../src/registry";
import { sha256 } from "../src/mcp/crypto";
import { input } from "./helpers";

const TOKEN = "test-admin-only";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const ACCOUNT = "synthetic-account";
const registry = () => env.REGISTRY.getByName("main");
// 不签名的合成 JWT：pi-ai 只解码 payload 取 chatgpt_account_id。
const jwt = (payload: object) => ["e30", Buffer.from(JSON.stringify(payload)).toString("base64url"), "synthetic"].join(".");
const access = (tag: string) => jwt({ tag, "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT }, "https://api.openai.com/profile": { email: "owner@example.test" } });
const credential = (tag: string, expires: number): Credential => ({ type: "oauth", access: access(tag), refresh: `refresh-${tag}`, expires, accountId: ACCOUNT });
const store = () => remoteCredentials(registry);

function admin(method: string, path: string, body?: unknown) {
  return worker.fetch(new Request(`https://test${path}`, { method, headers: { Authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body) }), { ...env, ADMIN_TOKEN: TOKEN });
}
async function adminJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await admin(method, path, body);
  if (!response.ok) throw new Error(`admin ${method} ${path} -> ${response.status}: ${await response.text()}`);
  return response.json<T>();
}
async function selectModel(model: ModelView["current"]): Promise<Response> {
  const { revision } = await adminJson<ModelView>("GET", "/admin/model");
  return admin("PUT", "/admin/model", { model, expectedRevision: revision });
}
type Sent = { url: string; headers: Headers; body: string };
function tokenEndpoint(sent: Sent[], tag: string, delay = 0) {
  return async (request: Request): Promise<Response> => {
    sent.push({ url: request.url, headers: request.headers, body: new TextDecoder().decode(await request.arrayBuffer()) });
    await new Promise(resolve => setTimeout(resolve, delay));
    return Response.json({ access_token: access(tag), refresh_token: `refresh-${tag}`, expires_in: 864000, id_token: jwt({ email: "owner@example.test" }) });
  };
}
function routeFetch(routes: Record<string, (request: Request) => Promise<Response>>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const request = new Request(url, init);
    const route = routes[request.url];
    if (!route) throw new Error(`network disabled in tests: ${request.url}`);
    return route(request);
  });
}
async function login(): Promise<{ sent: Sent[]; state: string; challenge: string }> {
  const sent: Sent[] = [];
  routeFetch({ [TOKEN_URL]: tokenEndpoint(sent, "login") });
  const { url } = await adminJson<{ url: string }>("POST", "/admin/model/oauth/codex/start");
  const authorize = new URL(url), state = authorize.searchParams.get("state") ?? "";
  expect(await adminJson("POST", "/admin/model/oauth/codex/complete", { callbackUrl: `http://localhost:1455/auth/callback?code=synthetic-code&state=${state}` }))
    .toEqual({ loggedIn: true, email: "owner@example.test" });
  return { sent, state, challenge: authorize.searchParams.get("code_challenge") ?? "" };
}

beforeEach(() => { vi.stubGlobal("WebSocket", vi.fn()); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await reset(); });

describe("model credentials", () => {
  it("refreshes once for concurrent requests from separate stores and keeps the rotated refresh token", async () => {
    await store().modify("openai-codex", async () => credential("old", Date.now() - 1000));
    const sent: Sent[] = [];
    routeFetch({ [TOKEN_URL]: tokenEndpoint(sent, "new", 50) });
    // 两份 Models 相当于两个 Thread DO，各自经 Registry 租锁。
    const [a, b] = await Promise.all([models.openModels(env, store()), models.openModels(env, store())].map(m => m.getAuth("openai-codex")));
    expect(sent).toHaveLength(1);
    expect(new URLSearchParams(sent[0]!.body).get("refresh_token")).toBe("refresh-old");
    expect(a?.auth.apiKey).toBe(access("new"));
    expect(b?.auth.apiKey).toBe(access("new"));
    expect(await store().read("openai-codex")).toMatchObject({ refresh: "refresh-new", accountId: ACCOUNT });
  });

  it("stores only ciphertext and non-secret metadata", async () => {
    await store().modify("openai-codex", async () => credential("stored", Date.now() + 3600_000));
    const rows = await runInDurableObject(registry(), (_instance, state) => state.storage.sql.exec("SELECT * FROM model_credentials").toArray());
    expect(rows).toEqual([expect.objectContaining({ provider_id: "openai-codex", credential_enc: expect.stringMatching(/^v1\./) })]);
    const text = JSON.stringify(rows);
    for (const secret of [access("stored"), "refresh-stored"]) expect(text).not.toContain(secret);
    expect(JSON.parse(String(rows[0]!.meta_json))).toEqual({ type: "oauth", accountId: ACCOUNT, expiresAt: expect.any(Number) });
  });

  it("reports Codex as unconfigured without OAUTH_STORE_KEY instead of failing", async () => {
    const view = await runInDurableObject(registry(), async (_instance, state) => {
      const instance = new RegistryDO(state, { ...env, OAUTH_STORE_KEY: undefined });
      await expect(instance.codexLoginStart()).rejects.toThrow("unconfigured");
      return instance.modelView();
    });
    expect(view.providers.find(provider => provider.id === "openai-codex")).toMatchObject({ available: false, reason: "unconfigured" });
    expect(view.codex.loggedIn).toBe(false);
  });
});

describe("ChatGPT login", () => {
  it("runs start → pasted callback → PKCE token exchange → logout", async () => {
    const { sent, challenge } = await login();
    const body = new URLSearchParams(sent[0]!.body);
    expect(Object.fromEntries(body)).toMatchObject({ grant_type: "authorization_code", code: "synthetic-code", redirect_uri: "http://localhost:1455/auth/callback" });
    expect((await sha256(body.get("code_verifier") ?? "")).toString("base64url")).toBe(challenge);
    const view = await adminJson<ModelView>("GET", "/admin/model");
    expect(view.codex).toEqual({ loggedIn: true, email: "owner@example.test", expiresAt: expect.any(Number) });
    expect(view.providers.find(provider => provider.id === "openai-codex")).toMatchObject({ available: true, models: expect.arrayContaining([expect.objectContaining({ id: "gpt-6-sol" })]) });
    expect(await runInDurableObject(registry(), (_instance, state) => state.storage.sql.exec("SELECT COUNT(*) AS n FROM model_logins").one().n)).toBe(0);

    expect(await adminJson("POST", "/admin/model/oauth/codex/logout")).toEqual({ ok: true });
    expect((await adminJson<ModelView>("GET", "/admin/model")).codex).toEqual({ loggedIn: false });
  });

  it("rejects a foreign or expired state, a missing code and a replayed callback without echoing them", async () => {
    const sent: Sent[] = [];
    routeFetch({ [TOKEN_URL]: tokenEndpoint(sent, "login") });
    const complete = (callbackUrl: string) => admin("POST", "/admin/model/oauth/codex/complete", { callbackUrl });
    const state = new URL((await adminJson<{ url: string }>("POST", "/admin/model/oauth/codex/start")).url).searchParams.get("state");
    for (const [callbackUrl, error] of [
      ["http://localhost:1455/auth/callback?code=secret-code&state=foreign-state", "invalid_state"],
      [`http://localhost:1455/auth/callback?state=${state}`, "missing_code"],
      [`localhost:1455/auth/callback?error=access_denied&state=${state}`, "authorization_denied"],
    ] as const) {
      const response = await complete(callbackUrl);
      const text = await response.text();
      expect([response.status, JSON.parse(text)]).toEqual([400, { error }]);
      expect(text).not.toContain("secret-code");
    }
    await runInDurableObject(registry(), (_instance, db) => { db.storage.sql.exec("UPDATE model_logins SET expires_at = ?", Date.now() - 1); });
    expect((await (await complete(`http://localhost:1455/auth/callback?code=c&state=${state}`)).json())).toEqual({ error: "invalid_state" });
    expect(sent).toHaveLength(0);

    const fresh = new URL((await adminJson<{ url: string }>("POST", "/admin/model/oauth/codex/start")).url).searchParams.get("state");
    expect((await complete(`http://localhost:1455/auth/callback?code=c&state=${fresh}`)).status).toBe(200);
    expect((await complete(`http://localhost:1455/auth/callback?code=c&state=${fresh}`)).status).toBe(400);
    expect(sent).toHaveLength(1);
  });
});

describe("model selection", () => {
  it("defaults to vars and only allows Codex after login", async () => {
    const view = await adminJson<ModelView>("GET", "/admin/model");
    expect(view.current).toEqual({ provider: "faux", id: "test" });
    expect(view.providers.map(provider => [provider.id, provider.available, provider.reason])).toEqual([
      ["deepseek", false, "missing_key"], ["openai-codex", false, "login_required"], ["faux", true, undefined]]);
    const rejected = await selectModel({ provider: "openai-codex", id: "gpt-6-sol" });
    expect([rejected.status, await rejected.json()]).toEqual([400, { error: "invalid_model", reason: "login_required" }]);
    expect((await selectModel({ provider: "faux", id: "missing" })).status).toBe(400);

    await login();
    const saved = await selectModel({ provider: "openai-codex", id: "gpt-6-sol", reasoningEffort: "high" });
    expect(saved.status).toBe(200);
    expect((await saved.json<ModelView>()).current).toEqual({ provider: "openai-codex", id: "gpt-6-sol", reasoningEffort: "high" });
    const health = await (await worker.fetch(new Request("https://test/healthz"), env)).json<{ model: unknown }>();
    expect(health.model).toEqual({ provider: "openai-codex", id: "gpt-6-sol", reasoningEffort: "high", codexLoggedIn: true });

    // 已选的模型登出后不可用，但其他设置仍能保存
    await adminJson("POST", "/admin/model/oauth/codex/logout");
    expect((await (await worker.fetch(new Request("https://test/healthz"), env)).json<{ model: unknown }>()).model)
      .toEqual({ unavailable: "openai-codex/gpt-6-sol: login_required" });
    const settings = await adminJson<{ value: object; revision: string }>("GET", "/admin/settings");
    expect((await admin("PUT", "/admin/settings", { value: { ...settings.value, allowUsers: [] }, expectedRevision: settings.revision })).status).toBe(200);
  });

  it("switches the Thread to the newly selected model on its next turn", async () => {
    const used: string[] = [];
    const faux = fauxProvider({ models: [{ id: "test" }, { id: "test-alt" }], tokensPerSecond: Infinity });
    const respond: FauxResponseFactory = (_transcript, _options, _state, model) => {
      faux.setResponses([respond]);
      used.push(model.id);
      return fauxAssistantMessage("ok");
    };
    faux.setResponses([respond]);
    vi.spyOn(models, "openModels").mockImplementation((_env, credentials) => {
      const registry = createModels({ credentials }); registry.setProvider(faux.provider);
      return registry;
    });
    const owner = env.THREAD.getByName("owner");
    expect(await owner.submit(input(1, "第一句", 10000001))).toEqual({ status: "done" });
    expect((await selectModel({ provider: "faux", id: "test-alt" })).status).toBe(200);
    expect(await owner.submit(input(2, "第二句", 10000001))).toEqual({ status: "done" });
    expect(used).toEqual(["test", "test-alt"]);
  });
});

describe("Codex requests", () => {
  const sse = (text: string) => new Response([
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [] } },
    { type: "response.output_text.delta", output_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text }] } },
    { type: "response.completed", response: { status: "completed", usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
  async function requestBody(sent: Sent): Promise<{ model: string; reasoning?: { effort?: string } }> {
    if (sent.headers.get("content-encoding") !== "zstd") return JSON.parse(sent.body);
    const zlib = await import("node:zlib") as unknown as { zstdDecompressSync(data: Uint8Array): Uint8Array };
    return JSON.parse(new TextDecoder().decode(zlib.zstdDecompressSync(new Uint8Array(Buffer.from(sent.body, "latin1")))));
  }

  it("refreshes an expired token, then calls the Codex responses endpoint over SSE with the selected effort", async () => {
    await login();
    expect((await selectModel({ provider: "openai-codex", id: "gpt-6-sol", reasoningEffort: "high" })).status).toBe(200);
    await store().modify("openai-codex", async () => credential("expired", Date.now() - 1000));
    const order: string[] = [], tokens: Sent[] = [], calls: Sent[] = [];
    routeFetch({
      [TOKEN_URL]: async request => { order.push("token"); return tokenEndpoint(tokens, "fresh")(request); },
      [CODEX_URL]: async request => {
        order.push("codex");
        calls.push({ url: request.url, headers: request.headers, body: Buffer.from(await request.arrayBuffer()).toString("latin1") });
        return sse("好的");
      },
    });
    expect(await env.THREAD.getByName("owner").submit(input(1, "你好", 10000001))).toEqual({ status: "done" });
    expect(order).toEqual(["token", "codex"]);
    expect(new URLSearchParams(tokens[0]!.body).get("refresh_token")).toBe("refresh-expired");
    const headers = calls[0]!.headers;
    expect(headers.get("authorization")).toBe(`Bearer ${access("fresh")}`);
    expect(headers.get("chatgpt-account-id")).toBe(ACCOUNT);
    expect(headers.get("accept")).toBe("text/event-stream");
    expect(await requestBody(calls[0]!)).toMatchObject({ model: "gpt-6-sol", reasoning: { effort: "high" } });
    expect(WebSocket).not.toHaveBeenCalled();
    expect(await store().read("openai-codex")).toMatchObject({ access: access("fresh"), refresh: "refresh-fresh" });
  });
});

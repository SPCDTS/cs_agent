import { ModelAlarm } from "../src/model-alarm";
import { zstdDecompressSync } from "node:zlib";
import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import worker from "../src/index";
import * as models from "../src/models";
import { remoteCredentials } from "../src/model-credentials";
import { RegistryDO, type ModelView } from "../src/registry";
import { isChatGPTCredential, CODEX_CLIENT_ID, CODEX_MODELS_URL, CODEX_BASE_URL, RESOURCE, TOKEN_URL } from "../src/codex-login";
import { OAuthRefreshError } from "../src/codex-refresh-error";
import { sha256 } from "../src/mcp/crypto";
import { MediaRepository } from "../src/media/repository";
import { generateImage } from "../src/tools/imagegen";
import { input } from "./helpers";

const TOKEN = "test-admin-only";
const registry = () => env.REGISTRY.getByName("main");
const store = () => remoteCredentials(registry);
const keys = await generateKeyPair("RS256", { extractable: true });
const jwk = { ...await exportJWK(keys.publicKey), kid: "test-key", alg: "RS256", use: "sig" };
const scopes = "openid profile email offline_access";
const accessToken = (subject = "subject-a", tag = "initial") => [btoa('{"alg":"RS256"}'), btoa(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "account-" + subject }, tag,
})), "signature"].join(".");
const freshAccess = accessToken("subject-a", "fresh");
const catalog = [
  { slug: "gpt-6-astra", display_name: "GPT Astra", visibility: "list" },
  { slug: "gpt-6-sol", display_name: "GPT Sol", visibility: "hidden" },
];
function admin(method: string, path: string, body?: unknown, token = TOKEN) {
  return worker.fetch(new Request("https://test" + path, { method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) }), { ...env, ADMIN_TOKEN: TOKEN });
}
async function adminJson<T>(method: string, path: string, body?: unknown, token = TOKEN): Promise<T> {
  const response = await admin(method, path, body, token);
  if (!response.ok) throw new Error("admin " + path + " -> " + response.status + ": " + await response.text());
  return response.json<T>();
}
async function selectModel(model: ModelView["current"]) {
  const { revision } = await adminJson<ModelView>("GET", "/admin/model");
  return admin("PUT", "/admin/model", { model, expectedRevision: revision });
}
type Sent = { url: string; headers: Headers; body: string };
let sent: Sent[];
function network(overrides: Record<string, (request: Request) => Promise<Response>> = {}) {
  sent = [];
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const request = new Request(url, init);
    sent.push({ url: request.url, headers: request.headers, body: await request.clone().text() });
    if (overrides[request.url]) return overrides[request.url]!(request);
    if (request.url.endsWith("/.well-known/jwks.json")) return Response.json({ keys: [jwk] });
    if (request.url === CODEX_MODELS_URL) return Response.json({ models: catalog });
    if (request.url.endsWith("/.well-known/openid-configuration")) return Response.json({ revocation_endpoint: "https://auth.openai.com/api/accounts/oauth/revoke" });
    if (request.url.endsWith("/api/accounts/oauth/revoke")) return new Response(null, { status: 200 });
    throw new Error("unexpected network endpoint");
  });
}
type Begin = { url: string; verifier: string; redirectUri: string; state: string; clientId?: string };
async function begin(accountId?: string) {
  const { ticket } = await adminJson<{ ticket: string }>("POST", "/admin/model/oauth/codex/start", accountId ? { accountId } : {});
  const pending = await adminJson<Begin>("POST", "/admin/model/oauth/codex/bridge/begin", { port: 1455 }, ticket);
  return { ticket, pending };
}
async function tokens(pending: Begin, clientId = CODEX_CLIENT_ID, subject = "subject-a", scope = scopes, nonce?: string) {
  const id = await new SignJWT({ email: "owner@example.test", nonce: nonce ?? new URL(pending.url).searchParams.get("nonce") })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" }).setIssuer("https://auth.openai.com")
    .setAudience(clientId).setSubject(subject).setExpirationTime("1h").sign(keys.privateKey);
  return { access_token: accessToken(subject), refresh_token: "refresh-" + subject, token_type: "Bearer", expires_in: 3600, scope, id_token: id };
}
async function complete(attempt: Awaited<ReturnType<typeof begin>>, clientId = CODEX_CLIENT_ID, subject = "subject-a", scope = scopes, nonce?: string) {
  const callbackUrl = attempt.pending.redirectUri + "?code=secret-code&state=" + attempt.pending.state + "&client_id=" + clientId;
  return admin("POST", "/admin/model/oauth/codex/bridge/complete", { callbackUrl, tokens: await tokens(attempt.pending, clientId, subject, scope, nonce) }, attempt.ticket);
}
async function login(clientId = CODEX_CLIENT_ID, subject = "subject-a") {
  const attempt = await begin();
  expect((await complete(attempt, clientId, subject)).status).toBe(200);
  return attempt;
}
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

describe("Codex native authorization", () => {
  it("uses native PKCE and one-use pairing, verifies identity, encrypts tokens and lists the account catalog", async () => {
    network();
    const attempt = await login();
    const url = new URL(attempt.pending.url);
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: CODEX_CLIENT_ID,
      redirect_uri: "http://localhost:1455/auth/callback", scope: scopes, codex_cli_simplified_flow: "true" });
    expect(url.searchParams.has("resource")).toBe(false);
    expect((await sha256(attempt.pending.verifier)).toString("base64url")).toBe(url.searchParams.get("code_challenge"));
    const view = await adminJson<ModelView>("GET", "/admin/model");
    expect(view.codex).toMatchObject({ loggedIn: true, email: "owner@example.test", accounts: [expect.objectContaining({ loggedIn: true })] });
    expect(view.providers.find(p => p.id === "openai-codex")?.models).toEqual([{ id: "gpt-6-astra", name: "GPT Astra" }]);
    const rows = await runInDurableObject(registry(), (_instance, state) => state.storage.sql.exec("SELECT * FROM model_credentials").toArray());
    expect(rows[0]).toMatchObject({ credential_enc: expect.stringMatching(/^v1\./) });
    expect(JSON.stringify(rows)).not.toContain("refresh-subject-a");
    expect((await complete(attempt)).status).toBe(400);
    const reauth = await begin(view.codex.activeId);
    const next = new URL(reauth.pending.url);
    expect(next.searchParams.get("client_id")).toBe(CODEX_CLIENT_ID);
    expect(next.searchParams.get("redirect_uri")).toBe(attempt.pending.redirectUri);
    expect(next.searchParams.has("agent_name_hint")).toBe(false);
    expect(next.searchParams.has("id_token_hint")).toBe(true);
  });

  it("rejects a wrong nonce and a returning account identity change without replacing the active account", async () => {
    network(); await login();
    const first = (await adminJson<ModelView>("GET", "/admin/model")).codex.activeId;
    for (const [scope, nonce, subject, expected] of [
      [scopes, "wrong-nonce", "subject-a", "invalid_identity"],
      [scopes, undefined, "other-subject", "invalid_identity"],
    ] as const) {
      const attempt = await begin(first);
      const response = await complete(attempt, CODEX_CLIENT_ID, subject, scope, nonce);
      expect([response.status, await response.json()]).toEqual([400, { error: expected }]);
      expect((await adminJson<ModelView>("GET", "/admin/model")).codex.activeId).toBe(first);
    }
    const expired = await begin();
    await runInDurableObject(registry(), (_instance, state) => { state.storage.sql.exec("UPDATE chatgpt_logins SET expires_at = 0"); });
    expect((await complete(expired)).status).toBe(400);
  });

  it("keeps same-email registrations separate and finishes an in-flight refresh against its original account", async () => {
    network(); await login();
    const first = (await adminJson<ModelView>("GET", "/admin/model")).codex.activeId!;
    const lease = await registry().credentialAcquire("openai-codex");
    await login(CODEX_CLIENT_ID, "subject-b");
    const current = await store().read("openai-codex");
    expect(current).toMatchObject({ subject: "subject-b", accountId: "account-subject-b" });
    if (!isChatGPTCredential(lease.credential)) throw new Error("expected plan credential");
    await registry().credentialSettle("openai-codex", lease.lease, lease.updatedAt,
      { ...lease.credential, access: "refreshed-first" });
    expect(await store().read("openai-codex")).toMatchObject({ subject: "subject-b" });
    const view = await adminJson<ModelView>("POST", "/admin/model/oauth/codex/select", { accountId: first });
    expect(view.codex.accounts).toHaveLength(2);
    expect(await store().read("openai-codex")).toMatchObject({ clientId: CODEX_CLIENT_ID, access: "refreshed-first" });
    expect(sent.at(-1)?.headers.get("authorization")).toBe("Bearer refreshed-first");
    expect(await adminJson("POST", "/admin/model/oauth/codex/logout")).toEqual({ revoked: true });
    const loggedOut = await adminJson<ModelView>("GET", "/admin/model");
    expect(loggedOut.codex.loggedIn).toBe(false);
    expect(loggedOut.codex.accounts).toHaveLength(2);
    const revoke = sent.find(call => call.url.endsWith("/oauth/revoke"))!;
    expect(Object.fromEntries(new URLSearchParams(revoke.body))).toMatchObject({ client_id: CODEX_CLIENT_ID, token_type_hint: "refresh_token" });
    expect((await begin(first)).pending.clientId).toBe(CODEX_CLIENT_ID);
  });

  it("refreshes once across concurrent requests, using the issued client and rotating refresh token", async () => {
    network(); await login();
    await store().modify("openai-codex", async current => ({ ...current!, expires: Date.now() - 1 }));
    network({ [TOKEN_URL]: async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return Response.json({ access_token: freshAccess, refresh_token: "rotated", expires_in: 3600, token_type: "Bearer" });
    } });
    const [a, b] = await Promise.all([models.openModels(env, store()), models.openModels(env, store())].map(m => m.getAuth("openai-codex")));
    expect(sent.filter(call => call.url === TOKEN_URL)).toHaveLength(1);
    expect(Object.fromEntries(new URLSearchParams(sent[0]!.body))).toEqual({
      grant_type: "refresh_token", client_id: CODEX_CLIENT_ID, refresh_token: "refresh-subject-a",
    });
    expect(a?.auth.apiKey).toBe(freshAccess); expect(b?.auth.apiKey).toBe(freshAccess);
    expect(await store().read("openai-codex")).toMatchObject({ refresh: "rotated" });
  });


  it("reports expiring credentials without refreshing during status reads, then records the failed request and account state", async () => {
    network(); await login();
    expect((await selectModel({ provider: "openai-codex", id: "gpt-6-astra" })).status).toBe(200);
    await store().modify("openai-codex", async current => ({ ...current!, expires: Date.now() - 1 }));
    network({ [TOKEN_URL]: async () => Response.json({ error: "invalid_grant", error_description: "secret-refresh-token", access_token: "never-expose" },
      { status: 400, headers: { "x-request-id": "req-refresh-test", "set-cookie": "never-expose-cookie" } }) });
    const expired = await adminJson<ModelView>("GET", "/admin/model");
    expect(expired.codex).toMatchObject({ status: "refresh_due", loggedIn: false, hasCredential: true, needsReauth: false });
    expect(await registry().modelStatus()).toEqual({ unavailable: "openai-codex/gpt-6-astra: refresh_due" });
    expect(sent).toHaveLength(0);
    await env.THREAD.getByName("owner").submit(input(1, "检查模型认证", 10000001));
    const failed = await adminJson<ModelView>("GET", "/admin/model");
    expect(failed.codex).toMatchObject({ status: "reauth_required", loggedIn: false, needsReauth: true,
      refreshFailure: { kind: "http", status: 400, oauthCode: "invalid_grant", requestId: "req-refresh-test", format: "json" } });
    const page = await env.REQUESTS.getByName("main").list({ since: 0, until: Date.now() + 1000, limit: 10 });
    expect(page.requests).toHaveLength(1);
    expect(page.requests[0]).toMatchObject({ status: "error", toolCalls: [] });
    expect(page.requests[0]?.error).toContain('"status":400');
    expect(page.requests[0]?.error).toContain("invalid_grant");
    expect(sent.filter(call => call.url === TOKEN_URL)).toHaveLength(1);
    expect(JSON.stringify([failed, page])).not.toMatch(/secret-refresh-token|never-expose/);
    expect(await store().read("openai-codex")).toMatchObject({ refresh: "refresh-subject-a" });
    await runInDurableObject(registry(), async (_instance, state) => {
      expect((await new RegistryDO(state, env).modelView()).codex.status).toBe("reauth_required");
    });
  });

  it.each([
    { label: "network", respond: async () => { throw new Error("Bearer never-expose-network"); }, expected: { kind: "network" } },
    { label: "timeout", respond: async () => { throw new DOMException("never-expose-timeout", "TimeoutError"); }, expected: { kind: "timeout" } },
    { label: "HTML challenge", respond: async () => new Response("<html>never-expose-html</html>", { status: 403,
      headers: { "content-type": "text/html", "cf-mitigated": "challenge", "cf-ray": "abc123-SJC" } }), expected: { kind: "http", status: 403, format: "html", challenge: true, cfRay: "abc123-SJC" } },
    { label: "rate limit", respond: async () => Response.json({ error: { code: "rate_limit_exceeded", message: "never-expose-message" } }, { status: 429 }),
      expected: { kind: "http", status: 429, oauthCode: "rate_limit_exceeded" } },
    { label: "invalid JSON", respond: async () => new Response("never-expose-json", { headers: { "content-type": "application/json" } }), expected: { kind: "invalid_json", status: 200 } },
    { label: "invalid fields", respond: async () => Response.json({ access_token: "never-expose-access" }), expected: { kind: "invalid_token_response", status: 200 } },
    { label: "unknown code", respond: async () => Response.json({ error: "never_expose_unknown_code", error_description: "never-expose" }, { status: 400 }),
      expected: { kind: "http", status: 400, oauthCode: "unrecognized" } },
  ])("classifies $label without claiming reauthorization or leaking upstream contents, and clears failure after recovery", async ({ respond, expected }) => {
    network(); await login();
    await store().modify("openai-codex", async current => ({ ...current!, expires: Date.now() - 1 }));
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    network({ [TOKEN_URL]: respond });
    const result = await admin("POST", "/admin/model/oauth/codex/catalog");
    expect(result.status).toBe(400);
    const body = await result.json();
    expect(body).toMatchObject({ error: "token_exchange", diagnostic: expected });
    const failed = await adminJson<ModelView>("GET", "/admin/model");
    expect(failed.codex).toMatchObject({ status: "refresh_failed", loggedIn: false, needsReauth: false, refreshFailure: expected });
    expect(JSON.stringify([body, failed, logs.mock.calls])).not.toContain("never-expose");
    expect(JSON.stringify([body, failed, logs.mock.calls])).not.toContain("never_expose");
    expect(logs).toHaveBeenCalledWith(expect.objectContaining({ event: "model_oauth_refresh_failed", ...expected }));
    network({ [TOKEN_URL]: async () => Response.json({ access_token: freshAccess, refresh_token: "rotated", expires_in: 3600, token_type: "Bearer" }) });
    await models.openModels(env, store()).getAuth("openai-codex");
    expect((await adminJson<ModelView>("GET", "/admin/model")).codex).toMatchObject({ status: "ready", loggedIn: true, needsReauth: false });
    expect((await adminJson<ModelView>("GET", "/admin/model")).codex.refreshFailure).toBeUndefined();
  });

  it("keeps the rotated refresh token when the subsequent model catalog request fails", async () => {
    network(); await login();
    await store().modify("openai-codex", async current => ({ ...current!, expires: Date.now() - 1 }));
    network({ [TOKEN_URL]: async () => Response.json({ access_token: freshAccess, refresh_token: "rotated", expires_in: 3600, token_type: "Bearer" }),
      [CODEX_MODELS_URL]: async () => new Response(null, { status: 503 }) });
    expect(await (await admin("POST", "/admin/model/oauth/codex/catalog")).json()).toMatchObject({ error: "catalog_failed", diagnostic: { kind: "http", status: 503 } });
    expect(await store().read("openai-codex")).toMatchObject({ access: freshAccess, refresh: "rotated" });
    expect((await adminJson<ModelView>("GET", "/admin/model")).codex.status).toBe("ready");
    await models.openModels(env, store()).getAuth("openai-codex");
    expect(sent.filter(call => call.url === TOKEN_URL)).toHaveLength(1);
  });

  it("does not let a delayed failure overwrite renewed credentials or mark a different account as failed", async () => {
    network(); await login();
    const first = (await adminJson<ModelView>("GET", "/admin/model")).codex.activeId;
    const lease = await registry().credentialAcquire("openai-codex");
    const failure = { at: Date.now(), kind: "network" } as const;
    await login(CODEX_CLIENT_ID, "subject-b");
    await registry().credentialSettle("openai-codex", lease.lease, lease.updatedAt, undefined, failure);
    expect((await adminJson<ModelView>("GET", "/admin/model")).codex).toMatchObject({ status: "ready" });
    expect((await adminJson<ModelView>("GET", "/admin/model")).codex.accounts.find(a => a.id === first)?.status).toBe("refresh_failed");
    const current = await registry().credentialAcquire("openai-codex");
    await registry().credentialSettle("openai-codex", current.lease, current.updatedAt, current.credential);
    await registry().credentialSettle("openai-codex", current.lease, current.updatedAt, undefined, failure);
    expect((await adminJson<ModelView>("GET", "/admin/model")).codex.status).toBe("ready");
    await expect(store().modify("openai-codex", async () => { throw new OAuthRefreshError({ at: Date.now(), kind: "aborted" }); })).rejects.toThrow("token_exchange");
    expect((await adminJson<ModelView>("GET", "/admin/model")).codex.status).toBe("ready");
  });

  it("requires fresh authorization for legacy credentials and reports a missing vault cleanly", async () => {
    await runInDurableObject(registry(), async (_instance, state) => {
      state.storage.sql.exec("INSERT INTO model_credentials VALUES (?, ?, ?, ?)", "openai-codex", "old-encrypted", 1, '{"type":"oauth"}');
    });
    const view = await adminJson<ModelView>("GET", "/admin/model");
    expect(view.codex).toMatchObject({ loggedIn: false, needsReauth: true });
    expect((await selectModel({ provider: "openai-codex", id: "gpt-6-astra" })).status).toBe(400);
    await runInDurableObject(registry(), async (_instance, state) => {
      const instance = new RegistryDO(state, { ...env, OAUTH_STORE_KEY: undefined });
      await expect(instance.codexLoginStart()).rejects.toThrow("unconfigured");
      expect((await instance.modelView()).providers.find(p => p.id === "openai-codex")?.reason).toBe("unconfigured");
    });
  });
});

describe("model selection and Codex Responses", () => {
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

  it("uses the native Codex endpoint over SSE with store false and the selected effort", async () => {
    network(); await login();
    expect((await selectModel({ provider: "openai-codex", id: "gpt-6-astra", reasoningEffort: "high" })).status).toBe(200);
    const requests: Sent[] = [];
    network({ [CODEX_BASE_URL + "/responses"]: async request => {
      requests.push({ url: request.url, headers: request.headers, body: request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(new Uint8Array(await request.arrayBuffer())).toString("utf8") : await request.text() });
      return new Response([
        { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [] } },
        { type: "response.output_text.delta", output_index: 0, delta: "好的" },
        { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "好的" }] } },
        { type: "response.completed", response: { status: "completed", usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } },
      ].map(event => "data: " + JSON.stringify(event) + "\n\n").join(""), { headers: { "Content-Type": "text/event-stream" } });
    } });
    const result = await env.THREAD.getByName("owner").submit(input(1, "你好", 10000001));
    expect(result).toEqual({ status: "done" });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer " + accessToken());
    expect(requests[0]!.headers.get("chatgpt-account-id")).toBe("account-subject-a");
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ model: "gpt-6-astra", store: false, stream: true, reasoning: { effort: "high" } });
    const payload = JSON.parse(requests[0]!.body);
    for (const key of ["max_output_tokens", "temperature", "prompt_cache_options", "prompt_cache_retention"]) expect(payload).not.toHaveProperty(key);
    expect(payload.input.some((item: { type?: string }) => item.type === "configuration_update")).toBe(false);
    expect(isChatGPTCredential(await store().read("openai-codex"))).toBe(true);
  });
});


describe("原生授权迁移与共享生图", () => {
  it("目录被拒绝时加密保存新授权并保留旧账号，无需重新登录即可恢复", async () => {
    network(); await login();
    const first = (await registry().modelView()).codex.activeId!;
    await runInDurableObject(registry(), (_instance, state) => {
      state.storage.sql.exec("UPDATE chatgpt_accounts SET client_id = ? WHERE id = ?", "oaiapp_legacy", first);
    });
    await store().modify("openai-codex", async current => ({ ...current!, flow: "chatgpt-plan", clientId: "oaiapp_legacy",
      scope: scopes + " resource.invoke chatgpt.tokens.use.direct", access: "legacy-access" }));
    const legacyModels = models.openModels(env, store());
    expect((await legacyModels.getAuth("openai-codex"))?.auth).toMatchObject({ apiKey: "legacy-access", baseUrl: RESOURCE });
    await expect(generateImage({ prompt: "画猫" }, { models: legacyModels,
      repository: new MediaRepository({ bucket: env.ASSETS, scope: "owner" }), operationId: "migration" })).rejects.toMatchObject({ code: "login_required" });
    const failed = await begin(first);
    network({ [CODEX_MODELS_URL]: async () => Response.json({ error: { code: "unsupported_country_region_territory", message: "never-expose-catalog-body" } },
      { status: 403, headers: { "x-request-id": "req-catalog-test" } }) });
    const saved = await complete(failed);
    expect(saved.status).toBe(200);
    const result = await saved.json<{ accountId: string; status: string }>();
    expect(result).toMatchObject({ status: "catalog_pending", diagnostic: { kind: "http", status: 403, oauthCode: "unsupported_country_region_territory", requestId: "req-catalog-test" } });
    const pending = await registry().modelView();
    expect(pending.codex.accounts.find(account => account.id === result.accountId)).toMatchObject({ status: "catalog_pending", loggedIn: false, catalogFailure: { status: 403 } });
    expect(JSON.stringify([result, pending])).not.toMatch(/never-expose|refresh-subject-a/);
    await runInDurableObject(registry(), async (_instance, state) => {
      const restored = await new RegistryDO(state, env).modelView();
      expect(restored.codex.accounts.find(account => account.id === result.accountId)?.status).toBe("catalog_pending");
      expect(state.storage.sql.exec("SELECT * FROM model_credentials").toArray()).toHaveLength(2);
    });
    expect((await registry().modelView()).codex.activeId).toBe(first);
    expect((await legacyModels.getAuth("openai-codex"))?.auth.apiKey).toBe("legacy-access");
    network();
    await registry().codexSelect(result.accountId);
    expect(sent.map(call => call.url)).toEqual([CODEX_MODELS_URL]);
    const view = await registry().modelView();
    expect(view.codex).toMatchObject({ flow: "codex-native", imageGeneration: true });
    expect(view.codex.accounts).toHaveLength(2);
    expect(view.codex.activeId).toBe(result.accountId);
    expect(view.codex.catalogFailure).toBeUndefined();
    expect(await store().read("openai-codex")).toMatchObject({ refresh: "refresh-subject-a" });
    network({ [RESOURCE + "/models"]: async () => Response.json({ models: catalog }) });
    await registry().codexSelect(first);
    expect((await models.openModels(env, store()).getAuth("openai-codex"))?.auth.apiKey).toBe("legacy-access");
  });

  it.each(["deepseek", "openai-codex"])("%s 回合用相同的 Codex 授权生图，网页只展示资产、不发送 QQ", async provider => {
    network(); await login();
    await store().modify("deepseek", async () => ({ type: "api_key", key: "synthetic-deepseek" }));
    const selection = { provider, id: provider === "openai-codex" ? "gpt-6-astra" : models.openModels(env, store()).getModels("deepseek")[0]!.id };
    expect((await selectModel(selection)).status).toBe(200);
    const spec = models.MODEL_PROVIDERS[provider]!, original = spec.create;
    const faux = fauxProvider({ provider, models: [{ id: selection.id }], tokensPerSecond: Infinity });
    let assetId = "", step = 0;
    const respond: FauxResponseFactory = transcript => {
      faux.setResponses([respond]);
      if (step++ === 0) return fauxAssistantMessage(fauxToolCall("generate_image", { prompt: "画一只猫" }), { stopReason: "toolUse" });
      const last = transcript.messages.findLast(message => message.role === "toolResult");
      if (last?.role === "toolResult" && last.toolName === "generate_image") {
        const text = last.content.find(part => part.type === "text");
        if (text?.type !== "text") throw new Error("missing image asset");
        assetId = JSON.parse(text.text).image.id;
        return fauxAssistantMessage(fauxToolCall("send_message", { text: "已生成", images: [assetId] }), { stopReason: "toolUse" });
      }
      return fauxAssistantMessage("done");
    };
    faux.setResponses([respond]);
    vi.spyOn(spec, "create").mockImplementation(() => ({ ...original(), stream: faux.provider.stream, streamSimple: faux.provider.streamSimple }));
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/mQAAAAASUVORK5CYII=";
    network({ [CODEX_BASE_URL + "/images/generations"]: async request => {
      expect(request.headers.get("authorization")).toBe("Bearer " + accessToken());
      expect(request.headers.get("chatgpt-account-id")).toBe("account-subject-a");
      expect(request.headers.get("x-codex-imagegen-request-id")).toMatch(/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
      expect(await request.json()).toMatchObject({ model: "gpt-image-2", prompt: "画一只猫", n: 1 });
      return Response.json({ data: [{ b64_json: png }] });
    } });
    const thread = env.THREAD.getByName("owner");
    await thread.submitWeb("owner", crypto.randomUUID(), "生成一张猫的图片");
    await expect.poll(async () => (await thread.chatView("owner")).messages.filter(message => message.role === "assistant").length).toBe(1);
    const page = await thread.chatView("owner");
    expect(JSON.stringify(page)).toContain(assetId);
    expect(assetId).toMatch(/^[a-f0-9]{64}$/);
    expect((await new MediaRepository({ bucket: env.ASSETS, scope: "owner" }).get(assetId)).ref.kind).toBe("image");
    expect(sent.filter(request => request.url.endsWith("/images/generations"))).toHaveLength(1);
    await runInDurableObject(thread, (_instance, state) => {
      expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM outbox").one().n).toBe(0);
    });
    const requestStore = env.REQUESTS.getByName("main");
    const user = page.messages.find(message => message.role === "user")!;
    await expect.poll(async () => (await requestStore.turnTrace("owner", [user.turnId!], 0)).tools.find(tool => tool.name === "generate_image")?.status).toBe("done");
  });
});

it("主 agent 与子 agent 工具续轮均由原 DO alarm 发出模型请求，管理读取不阻塞执行", async () => {
  network(); await login();
  await selectModel({ provider: "openai-codex", id: "gpt-6-astra" });
  const alarms = vi.spyOn(ModelAlarm.prototype, "dispatch");
  let parentCalls = 0, childCalls = 0;
  const owner = env.THREAD.getByName("owner");
  network({ [CODEX_BASE_URL + "/responses"]: async request => {
    const text = request.headers.get("content-encoding") === "zstd"
      ? zstdDecompressSync(new Uint8Array(await request.arrayBuffer())).toString("utf8") : await request.text();
    const owner = env.THREAD.getByName("owner");
    const childRequest = text.includes("你是主 agent 派出的子 agent");
    const step = childRequest ? childCalls++ : parentCalls++;
    if (childRequest) {
      const [child] = await owner.subagentList();
      expect(child).toBeDefined();
      expect(await owner.subagentTranscript(child!.id, 5)).toBeDefined();
    } else expect(await owner.chatView("owner")).toBeDefined();
    const item = step === 0
      ? { type: "function_call", id: "fc_" + (childRequest ? "child" : "parent"), call_id: "call_" + (childRequest ? "child" : "parent"),
          name: childRequest ? "qq_context" : "subagent", arguments: JSON.stringify(childRequest ? { limit: 1 } : { action: "spawn", task: "执行隔离验证" }) }
      : { type: "message", id: "msg_" + (childRequest ? "child" : "parent") + step, role: "assistant", status: "completed", content: [{ type: "output_text", text: "完成" }] };
    return new Response([
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } },
    ].map(event => "data: " + JSON.stringify(event) + "\n\n").join(""), { headers: { "Content-Type": "text/event-stream" } });
  } });
  expect(await owner.submit(input(55, "派子 agent 执行隔离验证", 10000001))).toEqual({ status: "done" });
  await vi.waitFor(async () => {
    const [child] = await owner.subagentList();
    expect(child?.status).toBe("done");
  });
  await owner.syncAdminView("owner");
  const [child] = await owner.subagentList();
  const display = env.REQUESTS.getByName("view:thread:owner");
  expect((await display.subagentTranscript(child.id, 10))?.entries.some(entry => entry.text === "完成")).toBe(true);
  expect(parentCalls).toBeGreaterThanOrEqual(2);
  expect(childCalls).toBe(2);
  expect(alarms.mock.calls.length).toBeGreaterThanOrEqual(parentCalls + childCalls);
});

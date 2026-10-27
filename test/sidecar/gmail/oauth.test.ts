import { createHash, randomBytes } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GmailOAuth, exchangeCode, readDesktopClient, SCOPES } from "../../../src/sidecar/gmail/oauth.js";
import { authorize } from "../../../src/sidecar/gmail/login.js";
import { REAUTHORIZE } from "../../../src/sidecar/gmail/errors.js";
import { SentStore } from "../../../src/sidecar/gmail/store.js";
import { requestJson, RESPONSE_LIMIT } from "../../../src/sidecar/gmail/http.js";
import { fixture, json, textOf } from "./helpers.js";

let current: Awaited<ReturnType<typeof fixture>> | undefined;
afterEach(async () => { await current?.cleanup(); current = undefined; });

describe("Gmail OAuth 与有界 Google 请求", () => {
  it("到期前 60 秒并发只刷新一次，原子存储后再次调用复用", async () => {
    const f = current = await fixture({ expiresInMs: 59_000 });
    await Promise.all([1, 2, 3].map(() => f.oauth.accessToken()));
    expect(f.tokenCalls).toBe(1);
    expect(f.tokenForms[0].get("grant_type")).toBe("refresh_token");
    expect(f.tokenForms[0].has("client_secret")).toBe(true);
    expect(f.tokenForms[0].has("refresh_token")).toBe(true);
    expect(await f.tokenJson()).toMatchObject({ scope: SCOPES, expires_at: expect.any(Number), obtained_at: expect.any(Number) });
    await f.oauth.accessToken();
    expect(f.tokenCalls).toBe(1);
    expect((await readdir(f.directory)).filter(name => name.endsWith(".tmp"))).toEqual([]);
    if (process.platform !== "win32") expect((await stat(f.tokenFile)).mode & 0o777).toBe(0o600);
  });

  it("invalid_grant 永久标记 invalid，后续工具返回重新授权文案", async () => {
    const f = current = await fixture({ expiresInMs: 0, token: (_req, res) => json(res, { error: "invalid_grant", error_description: "private diagnostic" }, 400) });
    const client = await f.connect();
    for (let i = 0; i < 2; i++) {
      const result = await client.callTool({ name: "gmail_read", arguments: { id: "one" } });
      expect(result).toMatchObject({ isError: true });
      expect(textOf(result)).toBe(REAUTHORIZE);
    }
    expect(f.tokenCalls).toBe(1);
    expect(f.gmailCalls).toBe(0);
    expect(await (await fetch(`${f.endpoint}/healthz`)).json()).toEqual({ ok: false, auth: "invalid", tools: 3 });
  });

  it("5xx 只使本次失败，下一次可刷新，原始 token 文件未被失败响应覆盖", async () => {
    let calls = 0;
    const f = current = await fixture({ expiresInMs: 0, token: (_req, res) => {
      calls++;
      if (calls === 1) json(res, { error: "invalid_grant" }, 503);
      else json(res, { access_token: randomBytes(24).toString("hex"), expires_in: 3600 });
    } });
    const original = await readFile(f.tokenFile);
    const result = await (await f.connect()).callTool({ name: "gmail_read", arguments: { id: "one" } });
    expect(result).toMatchObject({ isError: true });
    expect(f.oauth.auth).toBe("ready");
    expect((await readFile(f.tokenFile)).equals(original)).toBe(true);
    await f.oauth.accessToken();
    expect(f.tokenCalls).toBe(2);
    expect(f.oauth.auth).toBe("ready");
  });

  it("缺失与损坏 token 分别反映健康状态，均不发 Google 请求", async () => {
    const f = current = await fixture({ missing: true });
    expect(f.oauth.auth).toBe("missing");
    expect(await (await fetch(`${f.endpoint}/healthz`)).json()).toEqual({ ok: false, auth: "missing", tools: 3 });
    expect(await (await f.connect()).callTool({ name: "gmail_read", arguments: { id: "one" } })).toMatchObject({ isError: true });
    expect(f.gmailCalls).toBe(0);
    await writeFile(f.tokenFile, "{", { encoding: "utf8" });
    expect((await GmailOAuth.open(f.desktop, f.tokenFile)).auth).toBe("invalid");
  });

  it("授权 CLI 的回环回调校验 state、PKCE，并保存离线授权", async () => {
    const f = current = await fixture({ missing: true, token: (_req, res) => json(res, {
      access_token: randomBytes(24).toString("hex"), refresh_token: randomBytes(24).toString("hex"), expires_in: 3600,
    }) });
    let announce!: (url: URL) => void;
    const announced = new Promise<URL>(resolve => { announce = resolve; });
    const completion = authorize({ client: f.desktop, tokenFile: f.tokenFile, printUrl: url => announce(new URL(url)) });
    const url = await announced;
    expect(url.searchParams.get("scope")).toBe(SCOPES);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("include_granted_scopes")).toBe("false");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.has("client_secret")).toBe(false);
    const redirect = url.searchParams.get("redirect_uri");
    expect(redirect).toMatch(/^http:\/\/localhost:\d+$/u);
    if (!redirect) throw new Error("缺少回调");
    const callback = new URL(redirect);
    callback.hostname = "127.0.0.1";
    callback.search = new URLSearchParams({ state: "incorrect", code: randomBytes(24).toString("hex") }).toString();
    expect((await fetch(callback)).status).toBe(400);
    expect(f.tokenCalls).toBe(0);
    callback.searchParams.set("state", url.searchParams.get("state") ?? "");
    const response = await fetch(callback);
    expect(await response.text()).toContain("授权完成，可关闭");
    await completion;
    expect(f.tokenForms[0].get("grant_type")).toBe("authorization_code");
    expect(f.tokenForms[0].get("redirect_uri")).toBe(redirect);
    expect(createHash("sha256").update(f.tokenForms[0].get("code_verifier") ?? "").digest("base64url")).toBe(url.searchParams.get("code_challenge"));
    expect((await GmailOAuth.open(f.desktop, f.tokenFile)).auth).toBe("ready");
  });

  it("换码没有 refresh_token 时提示重新 consent，且不写 token", async () => {
    const f = current = await fixture({ missing: true });
    await expect(exchangeCode({ client: f.desktop, tokenFile: f.tokenFile, code: randomBytes(24).toString("hex"), verifier: randomBytes(32).toString("hex"), redirectUri: "http://localhost:12345" })).rejects.toThrow("prompt=consent");
    expect(await readdir(f.directory)).not.toContain("token.json");
  });

  it("登录超时关闭监听，客户端配置拒绝非 HTTPS", async () => {
    const f = current = await fixture();
    await expect(authorize({ client: f.desktop, tokenFile: f.tokenFile, timeoutMs: 20, printUrl: () => {} })).rejects.toThrow("等待超时");
    const file = join(f.directory, "client-fixture.json");
    await writeFile(file, JSON.stringify({ installed: f.desktop }), { encoding: "utf8" });
    await expect(readDesktopClient(file)).rejects.toThrow("客户端配置");
  });

  it("拒绝 origin 外请求，不跟随重定向，也不接受超过 8 MiB 的响应", async () => {
    let calls = 0;
    const f = current = await fixture({ gmail: (_req, res) => {
      calls++;
      if (calls === 1) res.writeHead(302, { Location: `${f.baseUrl}/redirected` }).end();
      else json(res, { content: "x".repeat(RESPONSE_LIMIT) });
    } });
    await expect(requestJson(new URL(`${f.baseUrl}/outside`), new Set(["https://gmail.googleapis.com"]))).rejects.toThrow("允许范围");
    expect(f.gmailCalls).toBe(0);
    await expect(f.gmail.read("one")).rejects.toThrow("Google 请求失败");
    expect(f.gmailCalls).toBe(1);
    await expect(f.gmail.read("one")).rejects.toThrow("8 MiB");
    expect(f.gmailCalls).toBe(2);
  });

  it("发送记录保留七天且损坏记录拒绝启动", async () => {
    const f = current = await fixture();
    const input = { to: "to@example.com", subject: "", body: "", idempotency_key: "expired-key" };
    await f.gmail.send(input);
    const file = join(f.stateDir, "sent.json");
    await writeFile(file, JSON.stringify({ "expired-key": { messageId: "old", threadId: "thread", at: Date.now() - 8 * 86400_000 } }), { encoding: "utf8" });
    const store = await SentStore.open(f.stateDir);
    const result = await store.send(input.idempotency_key, async () => ({ messageId: "new", threadId: "thread" }));
    expect(result.duplicate).toBe(false);
    await writeFile(file, "{", { encoding: "utf8" });
    await expect(SentStore.open(f.stateDir)).rejects.toThrow("幂等记录无法读取");
  });
});

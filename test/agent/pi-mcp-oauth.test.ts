import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { McpOAuth } from "../../src/agent/pi-mcp/oauth.js";
import { McpConnection } from "../../src/agent/pi-mcp/connection.js";
import { DEFAULT_MCP_LIMITS, type McpServerConfig } from "../../src/agent/pi-mcp/config.js";
import { redactText } from "../../src/shared/redact.js";
import { CLIENT_METADATA_URL, REDIRECT_URL, oauthFixture } from "./fixtures/pi-mcp-oauth.js";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const live = () => new AbortController().signal;
async function rig({ dualStack = false } = {}) {
  const fixture = await oauthFixture({ dualStack }); cleanup.push(fixture.close);
  const dataDir = await mkdtemp(join(tmpdir(), "pi-mcp-oauth-"));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const events: unknown[] = [];
  const resolvedHosts: string[] = [];
  const service = (config = fixture.config) => {
    const oauth = new McpOAuth({ dataDir, redirectUrl: REDIRECT_URL, servers: [config], allowLoopbackHttp: true,
      ...(dualStack ? { resolve: async (host: string) => {
        resolvedHosts.push(host);
        return [{ address: "::1", family: 6 }, { address: "127.0.0.1", family: 4 }];
      } } : {}),
      onEvent: (kind, detail) => events.push({ kind, detail }) });
    cleanup.push(() => oauth.close()); return oauth;
  };
  const oauth = service();
  const start = async () => {
    const result = await oauth.start("notion", "browser-cookie");
    if (!("authorizationUrl" in result)) throw new Error("fixture_no_redirect");
    const url = new URL(result.authorizationUrl);
    return { url, state: url.searchParams.get("state")!, code: await fixture.authorize(result.authorizationUrl) };
  };
  const login = async () => { const flow = await start(); await oauth.callback({ ...flow, cookieNonce: "browser-cookie" }); return flow; };
  const open = async (manager = oauth, server: McpServerConfig = fixture.config) => {
    const connection = await McpConnection.open({ server, limits: DEFAULT_MCP_LIMITS, secrets: { readReferencedVariable: () => undefined },
      signal: live(), onToolsChanged: () => {}, oauth: manager });
    cleanup.push(() => connection.close()); return connection;
  };
  const expire = () => {
    const db = new DatabaseSync(join(dataDir, "mcp-oauth.sqlite"));
    try { db.prepare("UPDATE oauth_tokens SET expires_at=?").run(Date.now() - 1000); } finally { db.close(); }
  };
  return { fixture, dataDir, oauth, service, start, login, open, events, expire, resolvedHosts };
}

describe("Pi MCP OAuth CIMD", () => {
  it("PKCE 登录保存 issuer/token/client，pending 单次消费，重开 SQLite 后仍能连接", async () => {
    const r = await rig(), flow = await r.start();
    expect(Object.fromEntries(flow.url.searchParams)).toMatchObject({ client_id: CLIENT_METADATA_URL, code_challenge_method: "S256",
      redirect_uri: REDIRECT_URL, scope: "default", state: expect.any(String) });
    expect(flow.state).toHaveLength(43);
    await r.oauth.callback({ ...flow, cookieNonce: "browser-cookie" });
    expect(r.fixture.registrations).toBe(0);
    const db = new DatabaseSync(join(r.dataDir, "mcp-oauth.sqlite"));
    try {
      expect(db.prepare("SELECT issuer,access_token,refresh_token FROM oauth_tokens").get()).toEqual({ issuer: r.fixture.issuer,
        access_token: r.fixture.token.access_token, refresh_token: r.fixture.token.refresh_token });
      expect(db.prepare("SELECT client_json FROM oauth_clients").get()?.client_json).toBe(JSON.stringify({ client_id: CLIENT_METADATA_URL, issuer: r.fixture.issuer }));
      expect(db.prepare("SELECT count(*) AS count FROM oauth_pending").get()?.count).toBe(0);
    } finally { db.close(); }
    await expect(r.oauth.callback({ ...flow, cookieNonce: "browser-cookie" })).rejects.toMatchObject({ code: "invalid_state" });
    const safe = JSON.stringify({ accounts: r.oauth.status(), events: r.events });
    expect(safe).not.toContain(r.fixture.token.access_token);
    expect(safe).not.toContain(r.fixture.token.refresh_token);
    expect(redactText(r.fixture.token.access_token)).not.toContain(r.fixture.token.access_token);
    await r.oauth.close();
    expect(await (await r.open(r.service())).listTools(live())).toHaveLength(1);
  });

  it("不匹配的 state/cookie 被拒绝，cookie 错误也消费 pending", async () => {
    const r = await rig(), flow = await r.start();
    await expect(r.oauth.callback({ ...flow, state: "unknown-state", cookieNonce: "browser-cookie" })).rejects.toMatchObject({ code: "invalid_state" });
    await expect(r.oauth.callback({ ...flow, cookieNonce: "another-browser" })).rejects.toMatchObject({ code: "invalid_state" });
    await expect(r.oauth.callback({ ...flow, cookieNonce: "browser-cookie" })).rejects.toMatchObject({ code: "invalid_state" });
    expect(r.fixture.grants).toEqual([]);
  });

  it("无 token 的运行时连接在任何网络请求前拒绝", async () => {
    const r = await rig();
    await expect(r.open()).rejects.toMatchObject({ code: "auth_required" });
    expect(r.fixture.paths).toEqual([]);
    expect(r.oauth.status()[0]).toMatchObject({ loggedIn: false, lastError: "auth_required" });
  });

  it("过期 token 主动刷新一次并保存轮换的 refresh token", async () => {
    const r = await rig(); await r.login();
    const old = r.fixture.token;
    r.expire();
    const [connection] = await Promise.all([r.open(), r.open()]);
    expect(await connection.listTools(live())).toHaveLength(1);
    expect(r.fixture.refreshes).toBe(1);
    expect(r.fixture.token.refresh_token).not.toBe(old.refresh_token);
    expect(await r.oauth.accessToken(r.fixture.config)).toMatchObject({ access_token: r.fixture.token.access_token });
    const db = new DatabaseSync(join(r.dataDir, "mcp-oauth.sqlite"));
    try { expect(db.prepare("SELECT refresh_token FROM oauth_tokens").get()?.refresh_token).toBe(r.fixture.token.refresh_token); }
    finally { db.close(); }
  });

  it("资源首个 401 在账号锁内刷新后重试，后续业务请求也沿用该路径", async () => {
    const r = await rig(); await r.login(); r.fixture.behavior.rejectNext = true;
    const connection = await r.open();
    expect(r.fixture.refreshes).toBe(1);
    r.fixture.behavior.rejectNext = true;
    expect(await connection.callTool("read", {}, live())).toMatchObject({ content: [{ text: "done" }] });
    expect(r.fixture.refreshes).toBe(2);
    r.fixture.behavior.rejectAlways = true;
    await expect(connection.callTool("read", {}, live())).rejects.toMatchObject({ code: "auth_required" });
    expect(r.fixture.refreshes).toBe(3);
  });

  it.each(["expired", "401"])("%s 刷新 invalid_grant 变为 auth_required，状态保留 refresh_failed", async mode => {
    const r = await rig(); await r.login(); r.fixture.behavior.invalidGrant = true;
    if (mode === "expired") r.expire();
    else r.fixture.behavior.rejectNext = true;
    await expect(r.open()).rejects.toMatchObject({ code: "auth_required" });
    expect(r.fixture.refreshes).toBe(1);
    expect(r.oauth.status()[0]).toMatchObject({ loggedIn: false, lastError: "refresh_failed" });
    expect(r.fixture.authorizations).toHaveLength(1);
    const db = new DatabaseSync(join(r.dataDir, "mcp-oauth.sqlite"));
    try { expect(db.prepare("SELECT count(*) AS count FROM oauth_tokens").get()?.count).toBe(0); }
    finally { db.close(); }
  });

  it("revision 轮换后旧账号 token 不被使用", async () => {
    const r = await rig(); await r.login();
    if (r.fixture.config.credential.kind !== "oauth") throw new Error("fixture_credential");
    const changed = { ...r.fixture.config, credential: { ...r.fixture.config.credential, revision: "2" } };
    const requests = r.fixture.paths.length;
    await expect(r.open(r.service(changed), changed)).rejects.toMatchObject({ code: "auth_required" });
    expect(r.fixture.paths).toHaveLength(requests);
  });

  it("显式 dynamic 使用 DCR；退出尽力撤销并删除本地 token", async () => {
    const r = await rig();
    if (r.fixture.config.credential.kind !== "oauth") throw new Error("fixture_credential");
    const changed = { ...r.fixture.config, credential: { ...r.fixture.config.credential, registration: "dynamic" as const } };
    const oauth = r.service(changed), result = await oauth.start("notion", "browser-cookie");
    if (!("authorizationUrl" in result)) throw new Error("fixture_no_redirect");
    expect(new URL(result.authorizationUrl).searchParams.get("client_id")).toBe("dynamic-fixture");
    await oauth.callback({ state: new URL(result.authorizationUrl).searchParams.get("state")!, code: await r.fixture.authorize(result.authorizationUrl), cookieNonce: "browser-cookie" });
    expect(r.fixture.registrations).toBe(1);
    expect(redactText("fixture-dynamic-secret")).not.toContain("fixture-dynamic-secret");
    const connection = await r.open(oauth, changed);
    await oauth.logout("notion");
    expect(r.fixture.revocations).toBe(1);
    expect(oauth.status()[0]).toMatchObject({ loggedIn: false, hasRefresh: false });
    const requests = r.fixture.paths.length;
    await expect(connection.callTool("read", {}, live())).rejects.toMatchObject({ code: "auth_required" });
    expect(r.fixture.paths).toHaveLength(requests);
    await expect(r.open(oauth, changed)).rejects.toMatchObject({ code: "auth_required" });
  });

  it("两个连接同时收到旧 token 的 401，只刷新一次且都成功", async () => {
    const r = await rig(); await r.login(); r.fixture.behavior.rejectConcurrent = true;
    const [a, b] = await Promise.all([r.open(), r.open()]);
    expect(r.fixture.rejectedTokens).toHaveLength(2);
    expect(new Set(r.fixture.rejectedTokens).size).toBe(1);
    expect(await a.listTools(live())).toHaveLength(1);
    expect(await b.listTools(live())).toHaveLength(1);
    expect(r.fixture.refreshes).toBe(1);
    expect(r.oauth.status()[0]).toMatchObject({ loggedIn: true, lastError: undefined });
  });

  it("T1 重试的迟到 401 不污染另一连接已保存的 T2，也不发送第三次请求", async () => {
    const r = await rig(); await r.login();
    const a = await r.open(), b = await r.open();
    await expect.poll(() => r.fixture.resourceMethods.filter(method => method === "GET").length).toBe(2);
    r.fixture.behavior.rejectNext = true; r.fixture.behavior.holdNextPost = true;
    const rejected = expect(a.callTool("read", {}, live())).rejects.toMatchObject({ code: "auth_required" });
    await expect.poll(() => r.fixture.hasDelayed401).toBe(true);
    expect(r.fixture.refreshes).toBe(1);
    r.fixture.behavior.rejectNext = true;
    expect(await b.callTool("read", {}, live())).toMatchObject({ content: [{ text: "done" }] });
    expect(r.fixture.refreshes).toBe(2);
    const status = r.oauth.status(), events = r.events.length, requests = r.fixture.resourceRequests;
    r.fixture.releaseDelayed401(); await rejected;
    expect(r.fixture.resourceRequests).toBe(requests);
    expect(r.oauth.status()).toEqual(status);
    expect(r.oauth.status()[0]).toMatchObject({ loggedIn: true, lastError: undefined });
    expect(r.events).toHaveLength(events);
    expect(await b.listTools(live())).toHaveLength(1);
  });

  it("SSE GET 持续 401 只刷新一次、GET 两次，然后以 auth_required 结束", async () => {
    const r = await rig(); await r.login(); r.fixture.behavior.rejectGetAlways = true;
    const connection = await r.open();
    await expect.poll(() => r.oauth.status()[0].lastError).toBe("auth_required");
    await expect(connection.listTools(live())).rejects.toMatchObject({ code: "auth_required" });
    expect(r.fixture.resourceMethods.filter(method => method === "GET")).toHaveLength(2);
    expect(r.fixture.refreshes).toBe(1);
  });

  it.each(["authorization_endpoint", "token_endpoint", "registration_endpoint", "revocation_endpoint"] as const)("元数据 %s 指向第三方时登录失败且第三方零请求", async endpoint => {
    const r = await rig(); r.fixture.behavior.endpoints[endpoint] = `${r.fixture.thirdPartyOrigin}/steal`;
    await expect(r.oauth.start("notion", "browser-cookie")).rejects.toMatchObject({ code: "auth_required" });
    expect(r.fixture.thirdPartyRequests).toBe(0);
    expect(r.fixture.grants).toEqual([]);
  });

  it("issuer 双栈解析首项 IPv6 不可达时，从固定地址列表回落 IPv4 完成登录", async () => {
    const r = await rig({ dualStack: true }); await r.login();
    expect(r.oauth.status()[0]).toMatchObject({ loggedIn: true, issuer: r.fixture.issuer });
    expect(r.resolvedHosts).toEqual(["localhost", "localhost"]);
    expect(r.fixture.grants).toEqual(["authorization_code"]);
  });

  it.each(["expired", "401"])("%s 刷新 503 只失败本次请求，下次恢复且无需登录", async mode => {
    const r = await rig(); await r.login(); r.fixture.behavior.refresh503Once = true;
    if (mode === "expired") r.expire(); else r.fixture.behavior.rejectNext = true;
    await r.oauth.close(); const oauth = r.service();
    const before = oauth.status()[0];
    await expect(r.open(oauth)).rejects.toMatchObject({ code: "transport_error" });
    expect(oauth.status()[0]).toEqual(before);
    expect(r.fixture.refreshes).toBe(1);
    if (mode === "401") r.fixture.behavior.rejectNext = true;
    expect(await (await r.open(oauth)).listTools(live())).toHaveLength(1);
    expect(r.fixture.refreshes).toBe(2);
    expect(r.fixture.authorizations).toHaveLength(1);
    expect(oauth.status()[0]).toMatchObject({ loggedIn: true, lastError: undefined });
  });
});

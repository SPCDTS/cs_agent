import { importPKCS8, SignJWT } from "jose";
import type { ConnectMark } from "./connect-diagnostics";

/** Separate operator-owned App; never reuse the development bot credentials. */
export type GitHubAppSecrets = { GITHUB_APP_ID?: string; GITHUB_APP_SLUG?: string; GITHUB_APP_PRIVATE_KEY?: string; GITHUB_APP_WEBHOOK_SECRET?: string; GITHUB_APP_CLIENT_ID?: string; GITHUB_APP_CLIENT_SECRET?: string; GITHUB_APP_CALLBACK_URL?: string };
export type AuthorizedRepository = { id: number; name: string };
export type GitHubUser = { id: number; login: string };
export type UserTokens = { access: string; refresh: string; expiresAt: number; refreshUntil: number };
export type UserAuthorization = { user: GitHubUser; repositories: AuthorizedRepository[]; expiresAt: number };
export const UPSTREAM_REASONS = ["request_init", "network", "timeout", "http_error", "empty_body", "invalid_encoding", "invalid_json",
  "server_error", "temporarily_unavailable", "body_too_large"] as const;
export type UpstreamReason = typeof UPSTREAM_REASONS[number];
export class GitHubAppError extends Error {
  constructor(readonly code: "unconfigured" | "unavailable" | "unauthorized" | "capacity" | "rate_limited" | "reauthorization_required" | "identity_changed" = "unavailable",
    readonly reason?: UpstreamReason, readonly upstreamStatus?: number) { super("github_app_" + code); }
}
const id = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const MAX_PAGES = 10, MAX_BYTES = 1024 * 1024;
export class GitHubAppClient {
  private readonly installationTokens = new Map<number,{token:string;until:number}>();
  constructor(private readonly secrets: GitHubAppSecrets) {}
  configured(): boolean {
    return /^\d{1,16}$/.test(this.secrets.GITHUB_APP_ID ?? "") && /^[a-z0-9][a-z0-9-]{0,99}$/.test(this.secrets.GITHUB_APP_SLUG ?? "")
      && !!this.secrets.GITHUB_APP_PRIVATE_KEY && !!this.secrets.GITHUB_APP_WEBHOOK_SECRET;
  }
  installationUrl(state: string): string {
    if (!this.configured()) throw new GitHubAppError("unconfigured");
    const url = new URL("https://github.com/apps/" + this.secrets.GITHUB_APP_SLUG + "/installations/new");
    url.searchParams.set("state", state); return url.href;
  }
  private callbackUrl(): string {
    try {
      const url = new URL(this.secrets.GITHUB_APP_CALLBACK_URL ?? "");
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/admin/github/oauth/callback") throw new Error();
      return url.href;
    } catch { throw new GitHubAppError("unconfigured"); }
  }
  authorizationUrl(state: string, challenge: string): string {
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new GitHubAppError("unauthorized");
    if (!this.configured() || !this.secrets.GITHUB_APP_CLIENT_ID || !this.secrets.GITHUB_APP_CLIENT_SECRET) throw new GitHubAppError("unconfigured");
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", this.secrets.GITHUB_APP_CLIENT_ID);
    url.searchParams.set("scope", "offline_access");
    url.searchParams.set("redirect_uri", this.callbackUrl()); url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge); url.searchParams.set("code_challenge_method", "S256");
    return url.href;
  }
  async exchange(code: string, verifier: string): Promise<UserTokens> {
    this.authorizationUrl("configuration-check", "x".repeat(43));
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(code) || !/^[A-Za-z0-9_-]{43}$/.test(verifier)) throw new GitHubAppError("unauthorized");
    const token = object(await this.requestJson("https://github.com/login/oauth/access_token", { method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "cs-agent-events" },
      body: new URLSearchParams({ client_id: this.secrets.GITHUB_APP_CLIENT_ID!, client_secret: this.secrets.GITHUB_APP_CLIENT_SECRET!, code, code_verifier: verifier, redirect_uri: this.callbackUrl() }),
    }));
    return this.tokens(token);
  }
  private tokens(token: Record<string, unknown>): UserTokens {
    if (["server_error","temporarily_unavailable"].includes(String(token.error))) throw new GitHubAppError("unavailable");
    if (typeof token.access_token !== "string" || !token.access_token || token.access_token.length > 4096 || token.token_type !== "bearer" || token.error
      || token.expires_in !== undefined && (typeof token.expires_in !== "number" || !Number.isFinite(token.expires_in) || token.expires_in <= 60)) throw new GitHubAppError("unauthorized");
    return { access: token.access_token, refresh: typeof token.refresh_token === "string" ? token.refresh_token : "",
      expiresAt: Date.now() + (typeof token.expires_in === "number" ? Math.min(token.expires_in, 28800) * 1000 : 365 * 86400_000),
      refreshUntil: typeof token.refresh_token_expires_in === "number" && Number.isFinite(token.refresh_token_expires_in)
        ? Date.now() + Math.min(token.refresh_token_expires_in, 15897600) * 1000 : 0 };
  }
  async refresh(tokens: UserTokens): Promise<UserTokens> {
    if (!tokens.refresh || tokens.refreshUntil <= Date.now()) throw new GitHubAppError("reauthorization_required");
    return this.tokens(object(await this.requestJson("https://github.com/login/oauth/access_token", { method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "cs-agent-events" },
      body: new URLSearchParams({ client_id: this.secrets.GITHUB_APP_CLIENT_ID ?? "", client_secret: this.secrets.GITHUB_APP_CLIENT_SECRET ?? "",
        grant_type: "refresh_token", refresh_token: tokens.refresh }) })));
  }
  async inspect(tokens: UserTokens, installationId: number): Promise<UserAuthorization> {
    if (!id(installationId)) throw new GitHubAppError("unauthorized");
    const token = { access_token: tokens.access }, expiresAt = Math.min(tokens.expiresAt, Date.now() + 600_000);
    const identity = object(await this.request("/user", token.access_token));
    if (!id(identity.id) || typeof identity.login !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(identity.login)) throw new GitHubAppError();
    const user: GitHubUser = { id: identity.id, login: identity.login };
    let found = false, expectedTotal: number | undefined; const seen = new Set<number>();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = object(await this.request("/user/installations?per_page=100&page=" + page, token.access_token));
      if (!Array.isArray(body.installations) || body.installations.length > 100 || !Number.isSafeInteger(body.total_count) || Number(body.total_count) < 0
        || expectedTotal !== undefined && expectedTotal !== body.total_count) throw new GitHubAppError();
      expectedTotal = Number(body.total_count); if (expectedTotal > MAX_PAGES * 100) throw new GitHubAppError("capacity");
      for (const entry of body.installations) {
        const installation = object(entry); if (!id(installation.id) || seen.has(installation.id)) throw new GitHubAppError(); seen.add(installation.id);
        if (installation.id === installationId && String(installation.app_id) === this.secrets.GITHUB_APP_ID && installation.suspended_at === null) found = true;
      }
      if (body.installations.length < 100 || seen.size === expectedTotal) {
        if (seen.size !== expectedTotal) throw new GitHubAppError();
        if (!found) throw new GitHubAppError("unauthorized");
        return { user, expiresAt, repositories: await this.repositoryPages("/user/installations/" + installationId + "/repositories", token.access_token) };
      }
    }
    throw new GitHubAppError("capacity");
  }
  async discover(tokens: UserTokens, mark: ConnectMark = () => {}): Promise<{ user: GitHubUser; installations: number[] }> {
    mark("user");
    const identity = object(await this.request("/user",tokens.access));
    if (!id(identity.id) || typeof identity.login !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(identity.login)) throw new GitHubAppError("unauthorized");
    mark("discover");
    const installations: number[] = [], seen = new Set<number>(); let total: number | undefined;
    for (let page=1; page<=MAX_PAGES; page++) {
      const data = object(await this.request("/user/installations?per_page=100&page="+page,tokens.access));
      if (!Array.isArray(data.installations) || data.installations.length>100 || !Number.isSafeInteger(data.total_count) || Number(data.total_count)<0
        || total !== undefined && total !== data.total_count) throw new GitHubAppError();
      total=Number(data.total_count); if(total>1000) throw new GitHubAppError("capacity");
      for (const item of data.installations) {
        const b=object(item); if(!id(b.id) || seen.has(b.id)) throw new GitHubAppError(); seen.add(b.id);
        if(String(b.app_id)===this.secrets.GITHUB_APP_ID && b.suspended_at===null) installations.push(b.id);
      }
      if(installations.length>20) throw new GitHubAppError("capacity");
      if(seen.size===total || data.installations.length<100) {
        if(seen.size!==total) throw new GitHubAppError();
        return {user:{id:identity.id,login:identity.login},installations};
      }
    }
    throw new GitHubAppError("capacity");
  }
  private async jwt(): Promise<string> {
    if (!this.configured()) throw new GitHubAppError("unconfigured");
    try {
      const key = await importPKCS8(this.secrets.GITHUB_APP_PRIVATE_KEY!, "RS256");
      return await new SignJWT({}).setProtectedHeader({ alg: "RS256" }).setIssuer(this.secrets.GITHUB_APP_ID!)
        .setIssuedAt(Math.floor(Date.now() / 1000) - 60).setExpirationTime(Math.floor(Date.now() / 1000) + 540).sign(key);
    } catch { throw new GitHubAppError("unconfigured"); }
  }
  private async request(path: string, token: string, method = "GET"): Promise<unknown> {
    return this.requestJson("https://api.github.com" + path, { method,
      headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "cs-agent-events" } });
  }
  private async requestJson(url: string, init: RequestInit): Promise<unknown> {
    // Only fixed GitHub origins and internally constructed paths. Never follow redirects or Link.
    let upstreamStatus: number | undefined;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10_000);
    try {
      let request: Request;
      try { request = new Request(url, { ...init, redirect: "manual", signal: controller.signal }); }
      catch { throw new GitHubAppError("unavailable", "request_init"); }
      const response = await fetch(request);
      upstreamStatus = response.status;
      if (!response.ok) {
        void response.body?.cancel();
        const limited = response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after"));
        throw new GitHubAppError(limited || response.status === 429 ? "rate_limited"
          : [401, 403, 404].includes(response.status) ? "unauthorized" : "unavailable", "http_error", upstreamStatus);
      }
      if (!response.body) throw new GitHubAppError("unavailable", "empty_body", upstreamStatus);
      const reader = response.body.getReader(); let size = 0; const parts: Uint8Array[] = [];
      try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length;
        if (size > MAX_BYTES) { await reader.cancel(); throw new GitHubAppError("capacity", "body_too_large", upstreamStatus); } parts.push(part.value); }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let at = 0; for (const part of parts) { bytes.set(part, at); at += part.length; }
      if (!size) throw new GitHubAppError("unavailable", "empty_body", upstreamStatus);
      let decoded: string, parsed: unknown;
      try { decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes); }
      catch { throw new GitHubAppError("unavailable", "invalid_encoding", upstreamStatus); }
      try { parsed = JSON.parse(decoded); }
      catch { throw new GitHubAppError("unavailable", "invalid_json", upstreamStatus); }
      if (url === "https://github.com/login/oauth/access_token") {
        const reason = object(parsed).error;
        if (reason === "server_error" || reason === "temporarily_unavailable")
          throw new GitHubAppError("unavailable", reason, upstreamStatus);
      }
      return parsed;
    } catch (error) { if (error instanceof GitHubAppError) throw error; throw new GitHubAppError("unavailable", controller.signal.aborted ? "timeout" : "network", upstreamStatus); }
    finally { clearTimeout(timer); }
  }
  /** Cache only the short-lived credential; revalidate installation authority and repository pages on every call. */
  async repositories(installationId: number, mark: ConnectMark = () => {}): Promise<AuthorizedRepository[]> {
    if (!id(installationId)) throw new GitHubAppError("unauthorized");
    mark("app_jwt");
    const jwt = await this.jwt();
    mark("install_repo");
    const installation = object(await this.request("/app/installations/" + installationId, jwt));
    if (installation.id !== installationId || String(installation.app_id) !== this.secrets.GITHUB_APP_ID || installation.suspended_at !== null)
      throw new GitHubAppError("unauthorized");
    const cached=this.installationTokens.get(installationId);
    if(cached && cached.until>Date.now()) {
      try { return await this.repositoryPages("/installation/repositories",cached.token); }
      catch(error) { this.installationTokens.delete(installationId); throw error; }
    }
    const issued = object(await this.request("/app/installations/" + installationId + "/access_tokens", jwt, "POST"));
    if (typeof issued.token !== "string" || !issued.token || typeof issued.expires_at !== "string" || Date.parse(issued.expires_at) <= Date.now() + 60_000 || !Number.isFinite(Date.parse(issued.expires_at)))
      throw new GitHubAppError();
    if(this.installationTokens.size>=400) this.installationTokens.clear();
    this.installationTokens.set(installationId,{token:issued.token,until:Math.min(Date.parse(issued.expires_at)-60_000,Date.now()+240_000)});
    try { return await this.repositoryPages("/installation/repositories", issued.token); }
    catch(error) { this.installationTokens.delete(installationId); throw error; }
  }
  private async repositoryPages(path: string, token: string): Promise<AuthorizedRepository[]> {
    const repositories: AuthorizedRepository[] = []; const seen = new Set<number>(); let expectedTotal: number | undefined;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = object(await this.request(path + "?per_page=100&page=" + page, token));
      if (!Array.isArray(body.repositories) || !Number.isSafeInteger(body.total_count) || Number(body.total_count) < 0) throw new GitHubAppError();
      if (body.repositories.length > 100 || expectedTotal !== undefined && expectedTotal !== body.total_count) throw new GitHubAppError();
      expectedTotal = Number(body.total_count);
      if (Number(body.total_count) > MAX_PAGES * 100) throw new GitHubAppError("capacity");
      for (const item of body.repositories) { const repo = object(item);
        if (!id(repo.id) || typeof repo.full_name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(repo.full_name) || seen.has(repo.id)) throw new GitHubAppError();
        seen.add(repo.id); repositories.push({ id: repo.id, name: repo.full_name });
      }
      if (body.repositories.length < 100) { if (repositories.length !== body.total_count) throw new GitHubAppError(); return repositories; }
      if (repositories.length === body.total_count) return repositories;
    }
    throw new GitHubAppError("capacity");
  }
}

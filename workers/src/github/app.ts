import { importPKCS8, SignJWT } from "jose";

/** Separate operator-owned App; never reuse the development bot credentials. */
export type GitHubAppSecrets = { GITHUB_APP_ID?: string; GITHUB_APP_SLUG?: string; GITHUB_APP_PRIVATE_KEY?: string; GITHUB_APP_WEBHOOK_SECRET?: string; GITHUB_APP_CLIENT_ID?: string; GITHUB_APP_CLIENT_SECRET?: string; GITHUB_APP_CALLBACK_URL?: string };
export type AuthorizedRepository = { id: number; name: string };
export class GitHubAppError extends Error {
  constructor(readonly code: "unconfigured" | "unavailable" | "unauthorized" | "capacity" = "unavailable") { super("github_app_" + code); }
}
const id = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const MAX_PAGES = 10, MAX_BYTES = 1024 * 1024;
export class GitHubAppClient {
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
  authorizationUrl(state: string): string {
    if (!this.configured() || !this.secrets.GITHUB_APP_CLIENT_ID || !this.secrets.GITHUB_APP_CLIENT_SECRET) throw new GitHubAppError("unconfigured");
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", this.secrets.GITHUB_APP_CLIENT_ID);
    url.searchParams.set("redirect_uri", this.callbackUrl()); url.searchParams.set("state", state);
    return url.href;
  }
  /** The setup callback's installation_id is a hint, not identity evidence. Never return/cache this user token. */
  async authorizeInstallation(code: string, installationId: number): Promise<void> {
    this.authorizationUrl("configuration-check");
    if (!id(installationId) || !/^[A-Za-z0-9_-]{1,512}$/.test(code)) throw new GitHubAppError("unauthorized");
    const token = object(await this.requestJson("https://github.com/login/oauth/access_token", { method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "cs-agent-events" },
      body: new URLSearchParams({ client_id: this.secrets.GITHUB_APP_CLIENT_ID!, client_secret: this.secrets.GITHUB_APP_CLIENT_SECRET!, code, redirect_uri: this.callbackUrl() }),
    }));
    if (typeof token.access_token !== "string" || !token.access_token || token.token_type !== "bearer" || token.error
      || token.expires_in !== undefined && (typeof token.expires_in !== "number" || !Number.isFinite(token.expires_in) || token.expires_in <= 60)) throw new GitHubAppError("unauthorized");
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
        if (!found) throw new GitHubAppError("unauthorized"); return;
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
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, { ...init, redirect: "error", signal: controller.signal });
      if (!response.ok) { void response.body?.cancel(); throw new GitHubAppError([401, 403, 404].includes(response.status) ? "unauthorized" : "unavailable"); }
      if (!response.body) throw new GitHubAppError();
      const reader = response.body.getReader(); let size = 0; const parts: Uint8Array[] = [];
      try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length;
        if (size > MAX_BYTES) { await reader.cancel(); throw new GitHubAppError("capacity"); } parts.push(part.value); }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let at = 0; for (const part of parts) { bytes.set(part, at); at += part.length; }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    } catch (error) { if (error instanceof GitHubAppError) throw error; throw new GitHubAppError(); }
    finally { clearTimeout(timer); }
  }
  /** No token cache: revoked/expired credentials never fall back to previously authorized repositories. */
  async repositories(installationId: number): Promise<AuthorizedRepository[]> {
    if (!id(installationId)) throw new GitHubAppError("unauthorized");
    const jwt = await this.jwt();
    const installation = object(await this.request("/app/installations/" + installationId, jwt));
    if (installation.id !== installationId || String(installation.app_id) !== this.secrets.GITHUB_APP_ID || installation.suspended_at !== null)
      throw new GitHubAppError("unauthorized");
    const issued = object(await this.request("/app/installations/" + installationId + "/access_tokens", jwt, "POST"));
    if (typeof issued.token !== "string" || !issued.token || typeof issued.expires_at !== "string" || Date.parse(issued.expires_at) <= Date.now() + 60_000 || !Number.isFinite(Date.parse(issued.expires_at)))
      throw new GitHubAppError();
    const repositories: AuthorizedRepository[] = []; const seen = new Set<number>(); let expectedTotal: number | undefined;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = object(await this.request("/installation/repositories?per_page=100&page=" + page, issued.token));
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

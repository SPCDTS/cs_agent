import { importPKCS8, SignJWT } from "jose";

/** Separate operator-owned App; never reuse the development bot credentials. */
export type GitHubAppSecrets = { GITHUB_APP_ID?: string; GITHUB_APP_SLUG?: string; GITHUB_APP_PRIVATE_KEY?: string; GITHUB_APP_WEBHOOK_SECRET?: string };
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
  private async jwt(): Promise<string> {
    if (!this.configured()) throw new GitHubAppError("unconfigured");
    try {
      const key = await importPKCS8(this.secrets.GITHUB_APP_PRIVATE_KEY!, "RS256");
      return await new SignJWT({}).setProtectedHeader({ alg: "RS256" }).setIssuer(this.secrets.GITHUB_APP_ID!)
        .setIssuedAt(Math.floor(Date.now() / 1000) - 60).setExpirationTime(Math.floor(Date.now() / 1000) + 540).sign(key);
    } catch { throw new GitHubAppError("unconfigured"); }
  }
  private async request(path: string, token: string, method = "GET"): Promise<unknown> {
    // All paths are constructed here. No Link headers, response URLs or callback URLs are followed.
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch("https://api.github.com" + path, { method, redirect: "error", signal: controller.signal,
        headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "cs-agent-events" } });
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

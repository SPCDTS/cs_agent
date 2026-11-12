import { GitHubAppClient, type GitHubAppSecrets } from "./app";
type Settings = GitHubAppSecrets & { GITHUB_APP_STORE_KEY?: string; GITHUB_MODE?: string };
export function githubMode(settings: Settings): "manual" | "app" | "invalid" {
  if (settings.GITHUB_MODE === "manual" || settings.GITHUB_MODE === "app") return settings.GITHUB_MODE;
  // Both modes require explicit operator intent; absence/typos must never choose a legacy secret.
  return "invalid";
}
export function githubAppConfigured(settings: Settings): boolean {
  if (!/^[a-f0-9]{64}$/i.test(settings.GITHUB_APP_STORE_KEY ?? "")) return false;
  try { new GitHubAppClient(settings).authorizationUrl("configuration-check","x".repeat(43)); return true; }
  catch { return false; }
}

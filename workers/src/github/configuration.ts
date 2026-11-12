import { GitHubAppClient, type GitHubAppSecrets } from "./app";
type Settings = GitHubAppSecrets & { GITHUB_APP_STORE_KEY?: string };
export function githubAppConfigured(settings: Settings): boolean {
  if (!/^[a-f0-9]{64}$/i.test(settings.GITHUB_APP_STORE_KEY ?? "")) return false;
  try { new GitHubAppClient(settings).authorizationUrl("configuration-check","x".repeat(43)); return true; }
  catch { return false; }
}

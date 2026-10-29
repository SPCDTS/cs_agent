import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// pool 自带八月的运行时，复用已安装 Wrangler 的 workerd 才能测试十月的部署兼容日期。
const workerd: unknown = createRequire(import.meta.url)("workerd");
if (workerd && typeof workerd === "object" && "default" in workerd && typeof workerd.default === "string") {
  process.env.MINIFLARE_WORKERD_PATH = workerd.default;
}

// test/codex-image.probe.test.ts 要真实的 ChatGPT 凭据：只在 CODEX_PROBE=1 时从本机 Codex CLI 的登录文件读出，
// 经 binding 交给这一次测试运行，不写进任何文件。
function probeBindings(): Record<string, string> {
  if (process.env.CODEX_PROBE !== "1") return {};
  const file = process.env.CODEX_PROBE_AUTH ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
  const tokens = (JSON.parse(readFileSync(file, "utf8")) as { tokens?: { access_token?: string; account_id?: string } }).tokens;
  if (!tokens?.access_token || !tokens.account_id) throw new Error(`CODEX_PROBE: ${file} 里没有 tokens.access_token 与 tokens.account_id`);
  return { CODEX_PROBE: "1", CODEX_PROBE_ACCESS: tokens.access_token, CODEX_PROBE_ACCOUNT: tokens.account_id };
}

// 0.23 / Vitest 4 已移除 defineWorkersConfig，改由插件配置同一套 Workers pool。
export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.test.jsonc" },
    miniflare: {
      bindings: { OAUTH_STORE_KEY: "01".repeat(32), NAPCAT_TOKEN: "t", QQ_OWNER: "10000001,10000002", QQ_ALLOW_USERS: "10000003", QQ_ALLOW_GROUPS: "200000001", MODEL_PROVIDER: "faux",
        GMAIL_CLIENT_ID: "synthetic-gmail-client", GMAIL_CLIENT_SECRET: "synthetic-gmail-secret", GMAIL_REFRESH_TOKEN: "synthetic-gmail-refresh", ...probeBindings() },
    },
  })],
  test: { testTimeout: 20_000 },
});

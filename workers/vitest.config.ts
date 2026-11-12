import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
export default defineConfig({
  // 测试显式使用合成服务目录，生产默认目录为空；覆盖 Notion 与 Workshop 两种接入。
  resolve: { alias: [{ find: "../../mcp.json", replacement: fileURLToPath(new URL("./test/fixtures/mcp.json", import.meta.url).href) }] },
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.test.jsonc" },
    miniflare: {
      bindings: { OAUTH_STORE_KEY: "01".repeat(32), NAPCAT_TOKEN: "t", QQ_OWNER: "10000001,10000002", QQ_ALLOW_USERS: "10000003", QQ_ALLOW_GROUPS: "200000001", MODEL_PROVIDER: "faux",
        GMAIL_CLIENT_ID: "synthetic-gmail-client", GMAIL_CLIENT_SECRET: "synthetic-gmail-secret", GMAIL_REFRESH_TOKEN: "synthetic-gmail-refresh" },
    },
  })],
  test: { testTimeout: 20_000 },
});

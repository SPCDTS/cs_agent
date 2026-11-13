import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
export default defineConfig({
  // 测试显式使用合成服务目录，生产默认目录为空；覆盖 Notion 与 Workshop 两种接入。
  resolve: { alias: [{ find: "../../mcp.json", replacement: fileURLToPath(new URL("./test/fixtures/mcp.json", import.meta.url).href) }] },
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.test.jsonc" },
    miniflare: {
      bindings: {
        GITHUB_APP_ID:"123",GITHUB_APP_SLUG:"test-events",GITHUB_APP_CLIENT_ID:"test-client",GITHUB_APP_CLIENT_SECRET:"synthetic-client-secret",
        GITHUB_APP_WEBHOOK_SECRET:"synthetic-test-secret-not-a-credential",GITHUB_APP_STORE_KEY:"03".repeat(32),
        GITHUB_APP_CALLBACK_URL:"https://test/admin/github/oauth/callback",
        GITHUB_APP_PRIVATE_KEY:generateKeyPairSync("rsa",{modulusLength:2048,privateKeyEncoding:{type:"pkcs8",format:"pem"},publicKeyEncoding:{type:"spki",format:"pem"}}).privateKey, OAUTH_STORE_KEY: "01".repeat(32), NAPCAT_TOKEN: "t", QQ_OWNER: "10000001,10000002", QQ_ALLOW_USERS: "10000003", QQ_ALLOW_GROUPS: "200000001", MODEL_PROVIDER: "faux",
        GMAIL_CLIENT_ID: "synthetic-gmail-client", GMAIL_CLIENT_SECRET: "synthetic-gmail-secret", GMAIL_REFRESH_TOKEN: "synthetic-gmail-refresh" },
    },
  })],
  // 保留每个测试文件的隔离；本机并发 2 个，CI 在同一台 runner 内并发 4 个。
  test: { testTimeout: 20_000, isolate: true, maxWorkers: process.env.CI ? 4 : 2 },
});

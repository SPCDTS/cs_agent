import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

// 测试显式使用合成服务目录与 faux 测试模型，生产默认目录为空且不打包 faux。
const ALIAS = [
  { find: "../../mcp.json", replacement: fileURLToPath(new URL("./test/fixtures/mcp.json", import.meta.url).href) },
  { find: "./providers/faux", replacement: fileURLToPath(new URL("./test/fixtures/models-faux.ts", import.meta.url).href) },
];

// 不依赖 cloudflare:test / workerd 运行时的纯逻辑单测划入轻量 node 项目，加快反馈。
const NODE_TESTS = [
  "test/chat-navigation-layout.test.ts",
  "test/events-model.test.ts",
  "test/execution-env.test.ts",
  "test/github-app.test.ts",
  "test/github-connect-diagnostics.test.ts",
  "test/github-upstream-diagnostics.test.ts",
  "test/github-user-auth.test.ts",
  "test/mcp-transport.test.ts",
  "test/memory-permissions.test.ts",
  "test/topology-layout.test.ts",
  "test/web-page.test.ts",
  "test/web-search.test.ts",
];

// Vitest 4 的内联 projects 不会继承顶层 testTimeout，各子项目需显式复用同一上限。
const TEST_TIMEOUT = 20_000;

export default defineConfig({
  // 保留每个测试文件的隔离；本机并发 2 个，CI 在同一台 runner 内并发 4 个。
  test: {
    testTimeout: TEST_TIMEOUT,
    maxWorkers: process.env.CI ? 4 : 2,
    projects: [
      {
        resolve: { alias: ALIAS },
        test: {
          name: "node",
          environment: "node",
          include: NODE_TESTS,
          testTimeout: TEST_TIMEOUT,
        },
      },
      {
        resolve: { alias: ALIAS },
        plugins: [cloudflareTest({
          wrangler: { configPath: "./wrangler.test.jsonc" },
          miniflare: {
            bindings: {
              GITHUB_APP_ID: "123", GITHUB_APP_SLUG: "test-events", GITHUB_APP_CLIENT_ID: "test-client", GITHUB_APP_CLIENT_SECRET: "synthetic-client-secret",
              GITHUB_APP_WEBHOOK_SECRET: "synthetic-test-secret-not-a-credential", GITHUB_APP_STORE_KEY: "03".repeat(32),
              GITHUB_APP_CALLBACK_URL: "https://test/admin/github/oauth/callback",
              GITHUB_APP_PRIVATE_KEY: generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey,
              AGENT_COMMUNICATION_EDGES: JSON.stringify([["owner","group:200000001"],["group:200000001","owner"]]),
              OAUTH_STORE_KEY: "01".repeat(32), NAPCAT_TOKEN: "t", QQ_OWNER: "10000001,10000002", QQ_ALLOW_USERS: "10000003", QQ_ALLOW_GROUPS: "200000001", MODEL_PROVIDER: "faux",
              GMAIL_CLIENT_ID: "synthetic-gmail-client", GMAIL_CLIENT_SECRET: "synthetic-gmail-secret", GMAIL_REFRESH_TOKEN: "synthetic-gmail-refresh",
            },
          },
        })],
        test: {
          name: "workers",
          include: ["test/**/*.test.ts"],
          exclude: NODE_TESTS,
          isolate: true,
          testTimeout: TEST_TIMEOUT,
        },
      },
    ],
  },
});

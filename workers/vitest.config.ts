import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { NODE_TESTS } from "./test/projects.mjs";

// 测试显式使用合成服务目录与 faux 测试模型，生产默认目录为空且不打包 faux。
const ALIAS = [
  { find: "../../mcp.json", replacement: fileURLToPath(new URL("./test/fixtures/mcp.json", import.meta.url).href) },
  { find: "./providers/faux", replacement: fileURLToPath(new URL("./test/fixtures/models-faux.ts", import.meta.url).href) },
];

// Vitest 4 的内联 projects 不会继承顶层 testTimeout，各子项目需显式复用同一上限。
const TEST_TIMEOUT = 12_000;

export default defineConfig({
  // 双池架构：node 池运行纯逻辑单测；workers 池保持 isolate: true，靠按业务域整合控制 workerd 启动次数（本机 2 并发、CI 3 并发）。
  test: {
    testTimeout: TEST_TIMEOUT,
    maxWorkers: process.env.CI ? 3 : 2,
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
          setupFiles: ["./test/setup-workers.ts"],
          isolate: true,
          testTimeout: TEST_TIMEOUT,
        },
      },
    ],
  },
});

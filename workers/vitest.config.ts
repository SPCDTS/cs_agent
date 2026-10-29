import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { createRequire } from "node:module";

// pool 自带八月的运行时，复用已安装 Wrangler 的 workerd 才能测试十月的部署兼容日期。
const workerd: unknown = createRequire(import.meta.url)("workerd");
if (workerd && typeof workerd === "object" && "default" in workerd && typeof workerd.default === "string") {
  process.env.MINIFLARE_WORKERD_PATH = workerd.default;
}

// 0.23 / Vitest 4 已移除 defineWorkersConfig，改由插件配置同一套 Workers pool。
export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.test.jsonc" },
    miniflare: {
      bindings: { OAUTH_STORE_KEY: "01".repeat(32), NAPCAT_TOKEN: "t", QQ_OWNER: "10000001,10000002", QQ_ALLOW_USERS: "10000003", QQ_ALLOW_GROUPS: "200000001", MODEL_PROVIDER: "faux",
        GMAIL_CLIENT_ID: "synthetic-gmail-client", GMAIL_CLIENT_SECRET: "synthetic-gmail-secret", GMAIL_REFRESH_TOKEN: "synthetic-gmail-refresh" },
    },
  })],
  test: { testTimeout: 20_000 },
});

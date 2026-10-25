import { defineConfig } from "vitest/config";

/**
 * 两个项目：
 * - unit（`npm test`）：进程内测试，不构建 dist、不启动 sh / PowerShell / 构建后的 MCP 子进程。
 * - integration（`npm run test:integration`）：真实子进程与脚本（entrypoint.sh、NapCat 播种脚本、
 *   dist/mcp/*.js 的 stdio 冒烟、bwrap 沙箱），先由 globalSetup 构建一次 dist。
 * `npm run test:all` 两个都跑。
 */
const INTEGRATION = [
  "test/entrypoint.test.ts",
  "test/napcat-config.test.ts",
  "test/mcp/im-stdio.test.ts",
  "test/mcp/qq-context-stdio.test.ts",
  "test/agent/pi-sandbox-linux.test.ts",
  "test/agent/pi-mcp-recovery.test.ts",
];

export default defineConfig({
  test: {
    testTimeout: 30000,
    // 动态端口范围从 1024 开始的 Windows 上，listen(0) 可能分到 fetch 禁用的端口（"fetch failed"）
    setupFiles: ["test/setup-fetchable-ports.ts"],
    // Windows 全并发曾出现原生 worker 退出及 HTTP 桩短超时；限制进程数，不减少测试。
    maxWorkers: process.platform === "win32" ? 2 : undefined,
    projects: [
      { extends: true, test: { name: "unit", include: ["test/**/*.test.ts"], exclude: INTEGRATION } },
      { extends: true, test: { name: "integration", include: INTEGRATION, globalSetup: ["test/build-stdio.ts"] } },
    ],
  },
});

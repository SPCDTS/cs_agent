import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ['test/build-stdio.ts'],
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    // Windows 全并发曾出现原生 worker 退出及 HTTP 桩短超时；限制进程数，不减少测试。
    maxWorkers: process.platform === "win32" ? 2 : undefined,
  },
});

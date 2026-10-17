import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ['test/build-stdio.ts'],
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
  },
});

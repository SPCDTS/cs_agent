import { test } from "node:test";
import assert from "node:assert/strict";
import { checkTestHygiene, MAX_WORKERS_TEST_FILES } from "./check-test-hygiene.mjs";

const validCfTest = `
import { env, reset } from "cloudflare:test";
import { afterEach, it } from "vitest";
afterEach(reset);
it("ok", async () => { await expect.poll(() => 1, { timeout: 10_000 }).toBe(1); });
`;

const validPureTest = `
import { expect, it } from "vitest";
it("pure", () => { expect(1).toBe(1); });
`;

test("合规的 workers 与 node 测试通过检查", () => {
  const errors = checkTestHygiene({
    workerTests: [
      { name: "alpha.test.ts", content: validCfTest },
      { name: "pure.test.ts", content: validPureTest },
      { name: "pump.test.ts", content: validPureTest },
    ],
    workerNodeTests: [{ name: "ui.node.mjs" }],
    runnerTests: [{ name: "jobs.test.ts" }],
    nodeTests: ["test/pure.test.ts"],
    workersRuntimeOnly: ["test/pump.test.ts"],
  });
  assert.deepEqual(errors, []);
});

test("拒绝过程命名、超长超时、未分流纯逻辑、node 误用 cloudflare:test 与漏写 reset", () => {
  const errors = checkTestHygiene({
    workerTests: [
      { name: "agent-fixes.test.ts", content: validCfTest },
      {
        name: "slow.test.ts",
        content: `import { reset } from "cloudflare:test";\nafterEach(reset);\nit("x", async () => {}, 25_000);\nit("y", async () => { await vi.waitFor(() => {}, { timeout: 15000 }); });`,
      },
      { name: "stray-pure.test.ts", content: validPureTest },
      { name: "bad-node.test.ts", content: validCfTest },
      { name: "no-reset.test.ts", content: `import { env } from "cloudflare:test";\nit("x", () => {});` },
    ],
    workerNodeTests: [{ name: "extra-review.node.mjs" }],
    runnerTests: [{ name: "wsb-regressions.test.ts" }],
    nodeTests: ["test/bad-node.test.ts"],
    workersRuntimeOnly: [],
  });
  assert.equal(errors.length, 8);
  assert.ok(errors.some(e => e.includes("agent-fixes.test.ts")));
  assert.ok(errors.some(e => e.includes("extra-review.node.mjs")));
  assert.ok(errors.some(e => e.includes("wsb-regressions.test.ts")));
  assert.ok(errors.some(e => e.includes("25000ms")));
  assert.ok(errors.some(e => e.includes("15000ms")));
  assert.ok(errors.some(e => e.includes("stray-pure.test.ts")));
  assert.ok(errors.some(e => e.includes("bad-node.test.ts")));
  assert.ok(errors.some(e => e.includes("no-reset.test.ts")));
});

test("允许同行的 ci-timeout-exempt 豁免且不误判 timeoutMs 字段", () => {
  const errors = checkTestHygiene({
    workerTests: [
      {
        name: "exempt.test.ts",
        content: `import { reset } from "cloudflare:test";
afterEach(reset);
const payload = { command: "echo hi", timeoutMs: 120000 };
it("exempt", async () => {}, 20_000); // ci-timeout-exempt: reason`,
      },
    ],
    nodeTests: [],
    workersRuntimeOnly: [],
  });
  assert.deepEqual(errors, []);
});

test("禁止在 afterEach 中先 restoreAllMocks 或在 reset 前调用 abortAllDurableObjects", () => {
  const errors = checkTestHygiene({
    workerTests: [
      {
        name: "bad-restore-order.test.ts",
        content: `import { reset } from "cloudflare:test";
import { afterEach, vi } from "vitest";
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});`,
      },
      {
        name: "bad-abort-order.test.ts",
        content: `import { abortAllDurableObjects, reset } from "cloudflare:test";
import { afterEach, vi } from "vitest";
afterEach(async () => {
  await abortAllDurableObjects();
  await reset();
  vi.restoreAllMocks();
});`,
      },
      {
        name: "good-reset-only.test.ts",
        content: `import { reset } from "cloudflare:test";
import { afterEach, vi } from "vitest";
afterEach(async () => {
  await reset();
  vi.restoreAllMocks();
});`,
      },
      {
        name: "good-reset-then-abort.test.ts",
        content: `import { abortAllDurableObjects, reset } from "cloudflare:test";
import { afterEach, vi } from "vitest";
afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
  vi.restoreAllMocks();
});`,
      },
    ],
    nodeTests: [],
    workersRuntimeOnly: [],
  });
  assert.equal(errors.length, 2);
  assert.ok(errors.some(e => e.includes("bad-restore-order.test.ts") && e.includes("restoreAllMocks")));
  assert.ok(errors.some(e => e.includes("bad-abort-order.test.ts") && e.includes("abortAllDurableObjects")));
});

test("超出 workers 池文件数预算时拒绝", () => {
  const errors = checkTestHygiene({
    workerTests: [
      { name: "alpha.test.ts", content: validCfTest },
      { name: "beta.test.ts", content: validCfTest },
    ],
    nodeTests: [],
    workersRuntimeOnly: [],
    maxWorkersTestFiles: 1,
  });
  assert.equal(MAX_WORKERS_TEST_FILES, 36);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes("超过预算上限"));
});

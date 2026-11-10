import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("订阅源分页与限流恢复的三个行为回归", () => {
  const python = process.env.CS_AGENT_TEST_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  const result = spawnSync(python, ["-B", fileURLToPath(new URL("./test_collect_feed.py", import.meta.url))], {
    encoding: "utf8", env: { ...process.env, PYTHONUTF8: "1" }, timeout: 30_000,
  });
  assert.equal(result.error, undefined, "需要 Python 3.9+；可用 CS_AGENT_TEST_PYTHON 指定现有解释器。" + (result.error?.message ?? ""));
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

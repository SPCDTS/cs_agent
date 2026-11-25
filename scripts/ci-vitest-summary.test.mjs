import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeVitestReport, formatSummaryMarkdown } from "./ci-vitest-summary.mjs";

test("正确统计墙钟耗时、累计测试时间、Top5 排行和软告警", () => {
  const analysis = analyzeVitestReport({
    startTime: 1_000,
    numTotalTests: 3,
    numPassedTests: 3,
    numFailedTests: 0,
    testResults: [
      {
        name: "/repo/workers/test/fast.test.ts",
        startTime: 1_100,
        endTime: 1_300,
        assertionResults: [{ fullName: "fast case", status: "passed", duration: 150 }],
      },
      {
        name: "/repo/workers/test/medium.test.ts",
        startTime: 1_200,
        endTime: 18_500,
        assertionResults: [
          { fullName: "slowish case", status: "passed", duration: 3_500 },
          { fullName: "heavy loop", status: "passed", duration: 12_000 },
        ],
      },
    ],
  }, { softTestMs: 3_000, softFileMs: 15_000, hardTestMs: 15_000, hardFileMs: 45_000 });

  assert.equal(analysis.fileCount, 2);
  assert.equal(analysis.testCount, 3);
  assert.equal(analysis.wallMs, 17_500);
  assert.equal(analysis.totalTestMs, 15_650);
  assert.equal(analysis.topFiles[0]?.file, "test/medium.test.ts");
  assert.equal(analysis.topTests[0]?.name, "heavy loop");
  assert.equal(analysis.violations.length, 0);
  assert.equal(analysis.warnings.length, 3);

  const md = formatSummaryMarkdown(analysis);
  assert.ok(md.includes("Top 5 最慢测试文件"));
  assert.ok(md.includes("test/medium.test.ts"));
  assert.ok(md.includes("慢测告警"));
});

test("超出硬红线时生成 violations 并在 Markdown 中标出", () => {
  const analysis = analyzeVitestReport({
    startTime: 0,
    numTotalTests: 1,
    numPassedTests: 1,
    numFailedTests: 0,
    testResults: [
      {
        name: "/repo/workers/test/monster.test.ts",
        startTime: 100,
        endTime: 50_000,
        assertionResults: [{ fullName: "monster case", status: "passed", duration: 48_000 }],
      },
    ],
  });

  assert.equal(analysis.violations.length, 2);
  const md = formatSummaryMarkdown(analysis);
  assert.ok(md.includes("超硬红线"));
  assert.ok(md.includes("违反硬耗时红线"));
});

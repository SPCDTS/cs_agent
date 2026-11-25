import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_BUDGETS = {
  softTestMs: 3_000,
  softFileMs: 15_000,
  hardTestMs: 10_000,
  hardFileMs: 45_000,
};

function shortFileName(rawPath) {
  const normalized = String(rawPath ?? "").replaceAll("\\", "/");
  const idx = normalized.lastIndexOf("/workers/");
  if (idx >= 0) return normalized.slice(idx + "/workers/".length);
  return normalized;
}

/**
 * 解析 Vitest JSON 报告，计算总耗时、最慢文件/用例并校验软告警与硬预算。
 */
export function analyzeVitestReport(report, budgets = DEFAULT_BUDGETS) {
  const merged = { ...DEFAULT_BUDGETS, ...budgets };
  const testResults = Array.isArray(report?.testResults) ? report.testResults : [];
  const fileEntries = [];
  const caseEntries = [];
  let maxEndTime = typeof report?.startTime === "number" ? report.startTime : 0;

  for (const file of testResults) {
    const fileName = shortFileName(file.name);
    const assertions = Array.isArray(file.assertionResults) ? file.assertionResults : [];
    let fileTestMs = 0;
    for (const item of assertions) {
      const duration = typeof item.duration === "number" && Number.isFinite(item.duration) ? item.duration : 0;
      fileTestMs += duration;
      caseEntries.push({
        file: fileName,
        name: item.fullName || item.title || "(unnamed)",
        status: item.status || "unknown",
        durationMs: duration,
      });
    }
    const endTime = typeof file.endTime === "number" && Number.isFinite(file.endTime) ? file.endTime : 0;
    const startTime = typeof file.startTime === "number" && Number.isFinite(file.startTime) ? file.startTime : endTime;
    if (endTime > maxEndTime) maxEndTime = endTime;
    fileEntries.push({
      file: fileName,
      tests: assertions.length,
      testMs: fileTestMs,
      wallMs: Math.max(0, endTime - startTime),
    });
  }

  const startTime = typeof report?.startTime === "number" && Number.isFinite(report.startTime) ? report.startTime : 0;
  const wallMs = Math.max(0, maxEndTime - startTime);
  const totalTestMs = fileEntries.reduce((sum, item) => sum + item.testMs, 0);
  const topFiles = [...fileEntries].sort((a, b) => b.testMs - a.testMs).slice(0, 5);
  const topTests = [...caseEntries].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);

  const warnings = [];
  const violations = [];
  for (const file of fileEntries) {
    if (file.testMs > merged.hardFileMs) {
      violations.push({ kind: "file", target: file.file, durationMs: file.testMs, limitMs: merged.hardFileMs });
    } else if (file.testMs > merged.softFileMs) {
      warnings.push({ kind: "file", target: file.file, durationMs: file.testMs, limitMs: merged.softFileMs });
    }
  }
  for (const item of caseEntries) {
    if (item.durationMs > merged.hardTestMs) {
      violations.push({ kind: "test", target: `${item.file} > ${item.name}`, durationMs: item.durationMs, limitMs: merged.hardTestMs });
    } else if (item.durationMs > merged.softTestMs) {
      warnings.push({ kind: "test", target: `${item.file} > ${item.name}`, durationMs: item.durationMs, limitMs: merged.softTestMs });
    }
  }

  return {
    fileCount: fileEntries.length,
    testCount: typeof report?.numTotalTests === "number" ? report.numTotalTests : caseEntries.length,
    passedTests: typeof report?.numPassedTests === "number" ? report.numPassedTests : caseEntries.filter(c => c.status === "passed").length,
    failedTests: typeof report?.numFailedTests === "number" ? report.numFailedTests : caseEntries.filter(c => c.status === "failed").length,
    wallMs,
    totalTestMs,
    topFiles,
    topTests,
    warnings,
    violations,
    budgets: merged,
  };
}

function fmtSec(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatSummaryMarkdown(analysis) {
  const lines = [
    "## Vitest 耗时摘要",
    "",
    `- 测试文件：**${analysis.fileCount}**，用例：**${analysis.passedTests}/${analysis.testCount}** passed（failed: ${analysis.failedTests}）`,
    `- 墙钟耗时：**${fmtSec(analysis.wallMs)}**，用例累计执行：**${fmtSec(analysis.totalTestMs)}**`,
    "",
    "### Top 5 最慢测试文件",
    "",
    "| 文件 | 用例数 | 用例耗时 | 预算状态 |",
    "| --- | ---: | ---: | --- |",
  ];
  for (const file of analysis.topFiles) {
    const status = file.testMs > analysis.budgets.hardFileMs ? "超硬红线" : file.testMs > analysis.budgets.softFileMs ? "慢测告警" : "正常";
    lines.push(`| \`${file.file}\` | ${file.tests} | ${Math.round(file.testMs)}ms | ${status} |`);
  }
  lines.push("", "### Top 5 最慢单个用例", "", "| 用例 | 耗时 | 预算状态 |", "| --- | ---: | --- |");
  for (const item of analysis.topTests) {
    const status = item.durationMs > analysis.budgets.hardTestMs ? "超硬红线" : item.durationMs > analysis.budgets.softTestMs ? "慢测告警" : "正常";
    lines.push(`| \`${item.file}\` — ${item.name.replaceAll("|", "\\|")} | ${Math.round(item.durationMs)}ms | ${status} |`);
  }
  if (analysis.warnings.length > 0) {
    lines.push("", `> [!WARNING]\n> 存在 ${analysis.warnings.length} 项慢测软告警（单用例 > ${analysis.budgets.softTestMs}ms 或单文件 > ${analysis.budgets.softFileMs}ms）：`);
    for (const w of analysis.warnings.slice(0, 10)) {
      lines.push(`> - [${w.kind}] \`${w.target}\` (${Math.round(w.durationMs)}ms)`);
    }
  }
  if (analysis.violations.length > 0) {
    lines.push("", `> [!CAUTION]\n> 违反硬耗时红线（单用例 > ${analysis.budgets.hardTestMs}ms 或单文件 > ${analysis.budgets.hardFileMs}ms）：`);
    for (const v of analysis.violations) {
      lines.push(`> - [${v.kind}] \`${v.target}\` (${Math.round(v.durationMs)}ms > ${v.limitMs}ms)`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const reportPath = process.argv[2];
  if (!reportPath) {
    console.error("用法: node scripts/ci-vitest-summary.mjs <vitest-report.json>");
    process.exit(1);
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const analysis = analyzeVitestReport(report);
  const markdown = formatSummaryMarkdown(analysis);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + "\n", "utf8");
  }
  console.log(
    `Vitest summary: ${analysis.fileCount} files, ${analysis.passedTests}/${analysis.testCount} tests, wall=${fmtSec(analysis.wallMs)}, totalTests=${fmtSec(analysis.totalTestMs)}, warnings=${analysis.warnings.length}, violations=${analysis.violations.length}`,
  );
  for (const file of analysis.topFiles) {
    console.log(`  file: ${Math.round(file.testMs)}ms (${file.tests}t) ${file.file}`);
  }
  for (const item of analysis.topTests) {
    console.log(`  test: ${Math.round(item.durationMs)}ms ${item.file} > ${item.name}`);
  }
  if (analysis.violations.length > 0) {
    console.error("耗时超出硬预算红线：\n" + analysis.violations.map(v => `  - [${v.kind}] ${v.target}: ${Math.round(v.durationMs)}ms > ${v.limitMs}ms`).join("\n"));
    process.exit(1);
  }
}

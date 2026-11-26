import { readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROCESS_NAMED_TEST = /-(?:fixes|fix|review|regressions|regression|pr\d+)\.(?:test\.ts|node\.mjs)$/i;
const TIMEOUT_LIMIT_MS = 12_000;
export const MAX_WORKERS_TEST_FILES = 36;
const INLINE_TIMEOUT = /\}\s*,\s*([\d_]+)\s*\)/g;
const OPTION_TIMEOUT = /\btimeout\s*:\s*([\d_]+)/g;
const CLOUDFLARE_TEST_IMPORT = /\bfrom\s+["']cloudflare:test["']|\bimport\s*\(\s*["']cloudflare:test["']\s*\)/;
const RESET_USAGE = /\breset\s*\(|\b(?:after|before)Each\s*\(\s*reset\s*\)/;

function extractAfterEachBlocks(content) {
  const blocks = [];
  const pattern = /\bafterEach\s*\(/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    let i = match.index + match[0].length;
    let depth = 1;
    let quote = "";
    while (i < content.length && depth > 0) {
      const ch = content[i];
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = "";
      } else if (ch === "\"" || ch === "'" || ch === "`") {
        quote = ch;
      } else if (ch === "(") {
        depth++;
      } else if (ch === ")") {
        depth--;
      }
      i++;
    }
    const line = content.slice(0, match.index).split(/\r?\n/).length;
    blocks.push({ line, text: content.slice(match.index, i) });
  }
  return blocks;
}

function callPositions(block, pattern) {
  const positions = [];
  const re = new RegExp(pattern.source, "g");
  let match;
  while ((match = re.exec(block)) !== null) positions.push(match.index);
  return positions;
}

function parseDuration(raw) {
  const value = Number(raw.replaceAll("_", ""));
  return Number.isFinite(value) ? value : 0;
}

/**
 * 静态检查仓库测试卫生规则，防止后续引入过程补丁文件、私自拉高超时、纯逻辑退回慢池或测试文件继续碎片化膨胀。
 * @param {{
 *   workerTests: Array<{ name: string; content: string }>;
 *   workerNodeTests?: Array<{ name: string }>;
 *   runnerTests?: Array<{ name: string }>;
 *   nodeTests: string[];
 *   workersRuntimeOnly: string[];
 *   maxWorkersTestFiles?: number;
 * }} entries
 * @returns {string[]}
 */
export function checkTestHygiene(entries) {
  const errors = [];
  const nodeSet = new Set(entries.nodeTests);
  const runtimeOnlySet = new Set(entries.workersRuntimeOnly);
  const maxWorkersTestFiles = entries.maxWorkersTestFiles ?? MAX_WORKERS_TEST_FILES;
  const workerMap = new Map(entries.workerTests.map(file => [`test/${file.name}`, file]));
  let workersPoolCount = 0;

  for (const name of [...nodeSet, ...runtimeOnlySet]) {
    if (!workerMap.has(name)) {
      errors.push(`projects.mjs 引用了不存在的测试文件：${name}`);
    }
  }

  for (const group of [
    ...(entries.workerNodeTests ?? []).map(file => `workers/test/${file.name}`),
    ...(entries.runnerTests ?? []).map(file => `runner/test/${file.name}`),
  ]) {
    if (PROCESS_NAMED_TEST.test(basename(group))) {
      errors.push(`禁止新增过程命名的测试文件（请合并到对应业务域测试）：${group}`);
    }
  }

  for (const file of entries.workerTests) {
    const rel = `test/${file.name}`;
    if (PROCESS_NAMED_TEST.test(file.name)) {
      errors.push(`禁止新增过程命名的测试文件（请合并到对应业务域测试）：workers/${rel}`);
    }

    const lines = file.content.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || line.includes("// ci-timeout-exempt:")) continue;
      for (const pattern of [INLINE_TIMEOUT, OPTION_TIMEOUT]) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(line)) !== null) {
          const ms = parseDuration(match[1]);
          if (ms > TIMEOUT_LIMIT_MS) {
            errors.push(
              `单测超时超过 ${TIMEOUT_LIMIT_MS}ms 上限：workers/${rel}:${idx + 1} (${ms}ms)；请改用小阈值注入/SQL预置/虚拟时钟`,
            );
          }
        }
      }
    }

    const importsCfTest = CLOUDFLARE_TEST_IMPORT.test(file.content);
    const inNode = nodeSet.has(rel);
    const inRuntimeOnly = runtimeOnlySet.has(rel);
    if (!inNode) {
      workersPoolCount += 1;
    }

    if (inNode && importsCfTest) {
      errors.push(`NODE_TESTS 中的文件不得导入 cloudflare:test：workers/${rel}`);
    } else if (!inNode && !inRuntimeOnly && !importsCfTest) {
      errors.push(`纯逻辑测试未登记到 workers/test/projects.mjs 的 NODE_TESTS（默认会掉入慢 workers 池）：workers/${rel}`);
    }

    if (!inNode && importsCfTest && !RESET_USAGE.test(file.content)) {
      errors.push(`workers 池测试必须调用 reset()（防止同文件跨用例 DO 状态串扰）：workers/${rel}`);
    }

    if (!inNode && importsCfTest) {
      for (const block of extractAfterEachBlocks(file.content)) {
        const resets = callPositions(block.text, /\breset\s*\(/);
        const aborts = callPositions(block.text, /\babortAllDurableObjects\s*\(/);
        const restores = callPositions(block.text, /\bvi\.(?:restoreAllMocks|unstubAllGlobals)\s*\(/);
        if (restores.length > 0 && (resets.length > 0 || aborts.length > 0)) {
          const lastCleanup = Math.max(...resets, ...aborts);
          if (restores[0] < lastCleanup) {
            errors.push(`workers 池测试 afterEach 必须先重置/清理 DO 再调用 restoreAllMocks()：workers/${rel}:${block.line}`);
          }
        }
        if (resets.length > 0 && aborts.length > 0 && aborts[0] < resets[0]) {
          errors.push(`workers 池测试 afterEach 禁止在 reset() 前调用 abortAllDurableObjects()：workers/${rel}:${block.line}`);
        }
      }
    }
  }

  if (workersPoolCount > maxWorkersTestFiles) {
    errors.push(
      `workers 池测试文件数（${workersPoolCount}）超过预算上限 ${maxWorkersTestFiles}；请优先合并至同业务域现有测试，或将纯逻辑拆分到 NODE_TESTS`,
    );
  }

  return errors;
}

export function scanRepositoryTests(rootDir) {
  const workersTestDir = join(rootDir, "workers", "test");
  const runnerTestDir = join(rootDir, "runner", "test");
  const workerEntries = readdirSync(workersTestDir);
  const workerTests = workerEntries
    .filter(name => name.endsWith(".test.ts"))
    .sort()
    .map(name => ({ name, content: readFileSync(join(workersTestDir, name), "utf8") }));
  const workerNodeTests = workerEntries
    .filter(name => name.endsWith(".node.mjs"))
    .sort()
    .map(name => ({ name }));
  const runnerTests = readdirSync(runnerTestDir)
    .filter(name => name.endsWith(".test.ts"))
    .sort()
    .map(name => ({ name }));
  return { workerTests, workerNodeTests, runnerTests };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const projects = await import(new URL("../workers/test/projects.mjs", import.meta.url).href);
  const scanned = scanRepositoryTests(rootDir);
  const errors = checkTestHygiene({
    ...scanned,
    nodeTests: projects.NODE_TESTS,
    workersRuntimeOnly: projects.WORKERS_RUNTIME_ONLY,
  });
  if (errors.length > 0) {
    console.error("测试卫生检查未通过：\n" + errors.map(err => `  - ${err}`).join("\n"));
    process.exit(1);
  }
  const nodeSet = new Set(projects.NODE_TESTS);
  const workersPoolCount = scanned.workerTests.filter(file => !nodeSet.has(`test/${file.name}`)).length;
  console.log(
    `测试卫生检查通过（workers 池: ${workersPoolCount}/${MAX_WORKERS_TEST_FILES}，node 池: ${projects.NODE_TESTS.length}，node.mjs: ${scanned.workerNodeTests.length}，runner: ${scanned.runnerTests.length}）`,
  );
}

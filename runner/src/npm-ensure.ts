import { ensureNpm } from "./npm-cache.ts";
const args = process.argv.slice(2), fresh = args.includes("--fresh");
try {
  const result = await ensureNpm({ cwd: process.cwd(), args: args.filter(value => value !== "--fresh"), fresh });
  console.log(result.reused ? "依赖配置与结构检查通过，复用 node_modules。" : result.code === 0 ? "依赖安装完成，已记录复用条件。" : "依赖安装失败，未记录成功标记。");
  process.exitCode = result.code;
} catch (error) { console.error(error instanceof Error ? error.message : "npm_prepare_failed"); process.exitCode = 1; }

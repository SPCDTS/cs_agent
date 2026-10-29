import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function exportMemory(ns, dataDir = path.resolve("data")) {
  if (!/^(?:owner|(?:group|private):[1-9][0-9]{0,19})$/.test(ns)) throw new Error("命名空间必须是 owner、group:<群号> 或 private:<QQ号>");
  // 只读打开，避免导出过程创建空库或改写 Docker 的原始数据。
  const db = new DatabaseSync(path.join(dataDir, "memory.sqlite"), { readOnly: true });
  try {
    let profile;
    try {
      // Docker 的目录名把冒号换成下划线，Windows 上也能读取同一份数据。
      const bytes = readFileSync(path.join(dataDir, "memory", ns.replace(/:/g, "_"), "profile.md"));
      profile = { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    return { ns, ...(profile ? { profile } : {}), memories: db.prepare("SELECT * FROM memories WHERE ns = ? ORDER BY id").all(ns) };
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error("usage");
    process.stdout.write(JSON.stringify(exportMemory(process.argv[2])) + "\n", "utf8");
  } catch {
    // 错误只给操作提示，不能把数据库正文或路径里的私密信息写进诊断。
    process.stderr.write("导出失败：请在仓库根目录执行 node workers/scripts/export-memory.mjs <ns>，并检查 data/memory.sqlite 与 UTF-8 画像。\n", "utf8");
    process.exitCode = 1;
  }
}

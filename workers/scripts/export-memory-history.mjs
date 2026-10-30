import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** 只读导出一个命名空间的当前快照及完整历史；source 在同一旧库的增量导出中必须保持不变。 */
export function exportMemoryHistory(ns, dataDir = path.resolve("data"), source = "legacy-memory") {
  if (!/^(?:owner|(?:group|private):[1-9][0-9]{0,19})$/.test(ns) || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(source)) throw new Error("invalid_export_options");
  const db = new DatabaseSync(path.join(dataDir, "memory.sqlite"), { readOnly: true });
  try {
    db.exec("BEGIN");
    const memories = db.prepare("SELECT * FROM memories WHERE ns = ? ORDER BY id").all(ns);
    const versions = db.prepare("SELECT v.* FROM memory_versions v JOIN memories m ON m.id=v.memory_id WHERE m.ns = ? ORDER BY v.id").all(ns);
    for (const row of versions) {
      for (const raw of [row.before_json, row.after_json]) if (raw !== null) {
        const snapshot = JSON.parse(raw);
        if (snapshot.id !== row.memory_id || snapshot.ns !== ns) throw new Error("invalid_history_snapshot");
      }
    }
    const links = db.prepare(`SELECT l.* FROM memory_links l JOIN memories a ON a.id=l.from_id JOIN memories b ON b.id=l.to_id
      WHERE a.ns = ? AND b.ns = ? ORDER BY l.from_id,l.to_id,l.rel`).all(ns, ns);
    const proposals = db.prepare("SELECT * FROM memory_proposals WHERE ns = ? ORDER BY id").all(ns);
    db.exec("COMMIT");
    return { format: "cs-agent-memory-history-v1", source, ns, memories, versions, links, proposals };
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = new Map();
    for (let i = 2; i < process.argv.length; i += 2) {
      const key = process.argv[i], value = process.argv[i + 1];
      if (!["--ns", "--output", "--data-dir", "--source"].includes(key) || !value || options.has(key)) throw new Error("invalid_arguments");
      options.set(key, value);
    }
    const bundle = exportMemoryHistory(options.get("--ns"), options.get("--data-dir"), options.get("--source"));
    const text = JSON.stringify(bundle) + "\n";
    if (options.has("--output")) writeFileSync(path.resolve(options.get("--output")), text, { encoding: "utf8", flag: "wx" });
    else process.stdout.write(text, "utf8");
  } catch {
    process.stderr.write("导出失败：node workers/scripts/export-memory-history.mjs --ns <命名空间> [--output <新文件>] [--data-dir <旧数据目录>] [--source <稳定来源标识>]。\n", "utf8");
    process.exitCode = 1;
  }
}

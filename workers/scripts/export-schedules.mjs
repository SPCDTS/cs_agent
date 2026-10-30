import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { applyImmutableBatches } from "@earendil-works/chord/delta";

function readDocument(db, kind) {
  const docs = db.prepare("SELECT id FROM documents WHERE kind = ? AND retired_at IS NULL").all(JSON.stringify(kind));
  if (docs.length > 1) throw new Error("duplicate document");
  if (!docs.length) return undefined;
  const revisions = db.prepare("SELECT kind, version, content FROM document_revisions WHERE document_id = ? ORDER BY seq").all(docs[0].id);
  const baseIndex = revisions.findLastIndex(revision => revision.kind === "base");
  if (baseIndex < 0 || revisions.slice(baseIndex).some(revision => revision.version !== 1)) throw new Error("unsupported document");
  return applyImmutableBatches(JSON.parse(revisions[baseIndex].content),
    revisions.slice(baseIndex + 1).map(revision => JSON.parse(revision.content)));
}

/** 只读还原 durable 文档；原始库不改写，提示词覆盖必须显式按任务 ID 提供。 */
export function exportSchedules(dataDir = path.resolve("data"), promptOverrides = {}) {
  if (!promptOverrides || typeof promptOverrides !== "object" || Array.isArray(promptOverrides) ||
      Object.values(promptOverrides).some(value => typeof value !== "string" || !value.trim())) throw new Error("invalid overrides");
  const db = new DatabaseSync(path.join(dataDir, "agent.sqlite"), { readOnly: true });
  try {
    db.exec("BEGIN");
    const state = readDocument(db, "cs.schedules"), runtime = readDocument(db, "cs.schedule.runtime");
    if (!state?.schedules) throw new Error("schedules missing");
    const schedules = Object.values(state.schedules).map(schedule => ({
      ...schedule,
      ...(Object.hasOwn(promptOverrides, schedule.id) ? { prompt: promptOverrides[schedule.id] } : {}),
      fire_count: runtime?.ordinals?.[schedule.id] ?? schedule.runs.filter(run => run.status !== "skipped").length,
    }));
    if (Object.keys(promptOverrides).some(id => !schedules.some(schedule => schedule.id === id))) throw new Error("unknown override");
    db.exec("COMMIT");
    return { dryRun: true, schedules };
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length > 4) throw new Error("usage");
    const overrides = process.argv[3] ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(process.argv[3]))) : {};
    process.stdout.write(JSON.stringify(exportSchedules(process.argv[2] ?? "data", overrides)) + "\n", "utf8");
  } catch {
    process.stderr.write("导出失败：用法 node workers/scripts/export-schedules.mjs [数据目录] [UTF-8 提示词覆盖.json]；检查旧库及文档版本。\n", "utf8");
    process.exitCode = 1;
  }
}

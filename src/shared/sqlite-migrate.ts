import type { DatabaseSync } from "node:sqlite";

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(c => c.name === column);
}

/**
 * 幂等、崩溃安全的列改名（SQLite ≥ 3.25 的 RENAME COLUMN）：改名与重建引用旧列名的索引在同一写事务内完成，
 * 中途崩溃整体回滚、下次打开重做；表不存在或已是新列名时什么都不做。多个进程同时打开同一个库时
 * 由 BEGIN IMMEDIATE 串行，事务内重新检查。必须在建索引（CREATE INDEX … 新列名）之前调用。
 * 返回是否实际改了名。
 */
export function renameColumn(db: DatabaseSync, table: string, from: string, to: string,
  indexes: { drop?: readonly string[]; create?: readonly string[] } = {}): boolean {
  if (!hasColumn(db, table, from)) return false;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!hasColumn(db, table, from) || hasColumn(db, table, to)) { db.exec("COMMIT"); return false; }
    db.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`);
    for (const name of indexes.drop ?? []) db.exec(`DROP INDEX IF EXISTS ${name}`);
    for (const sql of indexes.create ?? []) db.exec(sql);
    db.exec("COMMIT");
    return true;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

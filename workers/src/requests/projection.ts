import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { MEMORY_SUPPORT_SCHEMA } from "../memory/lifecycle";
import type { Env } from "../env";

// 只投影管理展示需要的表；不复制凭据、运行任务、工具恢复状态和完整请求快照。
export const VIEW_TABLES = ["messages", "inbound", "outbox", "web_outputs", "session_state", "session_resets", "events", "subagents",
  "memories", "memory_versions", "memory_links", "memory_imported_versions", "memory_jobs", "memory_proposals", "profile", "profile_sources", "profile_review", "memory_evidence", "memory_candidates", "extract_attempts", "extract_queue", "summaries",
  "mcp_access", "mcp_approvals", "mcp_catalog", "pi_entries", "pi_conversations", "meta"] as const;
export type ViewTable = typeof VIEW_TABLES[number];
export type ViewInfo = { agingLastRun: number | null; consolidateLastRun: number | null; compacting: boolean };
type Value = string | number | null;
type Schema = { table: ViewTable; columns: string[] };
type Change = { seq: number; table_name: ViewTable; row_key: number; value: string | null };
export type ProjectionBatch = { scope: string; schemas: Schema[]; changes: Change[]; at: number; complete: boolean; info: ViewInfo };
const quote = (name: string) => '"' + name + '"';
export const viewName = (scope: string) => "view:" + scope;

/** 与 Pi 使用同一个 storage 包装对象，因此继续共用事务队列。通知只标记脏数据，不在事务中做 RPC。 */
export function observeWrites(storage: DurableObjectStorage, changed: () => void): DurableObjectStorage {
  const sql = new Proxy(storage.sql, { get(target, key) {
    if (key === "exec") return (query: string, ...bindings: (string | number | null | ArrayBuffer | ArrayBufferView)[]) => {
      const result = target.exec(query, ...bindings);
      if (!query.includes("admin_projection") && /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(query)) changed();
      return result;
    };
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return new Proxy(storage, { get(target, key) {
    if (key === "sql") return sql;
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

/** 变更与原数据在同一 SQLite 事务内记账；同一行的多次变化合并，确认同步后才移除。 */
export class ProjectionPublisher {
  private installed = false;
  private scoped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private flushing?: Promise<void>;
  private lastInfo?: string;
  retryAt?: number;
  constructor(private readonly ctx: DurableObjectState, private readonly env: Env,
    private readonly scope: () => Promise<string>, private readonly wake: (at: number) => Promise<void>) {}

  install(): void {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS admin_projection_tables(name TEXT PRIMARY KEY, columns_json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS admin_projection_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,table_name TEXT NOT NULL,row_key INTEGER NOT NULL,value TEXT,UNIQUE(table_name,row_key))");
    for (const table of VIEW_TABLES) {
      const columns = sql.exec<{ name: string }>("SELECT name FROM pragma_table_info(?)", table).toArray().map(column => column.name);
      if (!columns.length) continue;
      if (columns.some(name => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name))) throw new Error("invalid_projection_column");
      const definition = JSON.stringify(columns);
      if (sql.exec<{ columns_json: string }>("SELECT columns_json FROM admin_projection_tables WHERE name=?", table).toArray()[0]?.columns_json === definition) continue;
      const values = (prefix: string) => "json_array(" + columns.map(name => prefix + quote(name)).join(",") + ")";
      const put = (key: string, value: string) => "INSERT INTO admin_projection_changes(table_name,row_key,value) VALUES ('" + table + "'," + key + "," + value + ") ON CONFLICT(table_name,row_key) DO UPDATE SET seq=excluded.seq,value=excluded.value;";
      for (const action of ["INSERT", "UPDATE", "DELETE"]) {
        const name = "admin_projection_" + table + "_" + action.toLowerCase();
        sql.exec("DROP TRIGGER IF EXISTS " + name);
        sql.exec("CREATE TRIGGER " + name + " AFTER " + action + " ON " + quote(table) + " BEGIN " + put(action === "DELETE" ? "old.rowid" : "new.rowid", action === "DELETE" ? "NULL" : values("new.")) + " END");
      }
      sql.exec("INSERT INTO admin_projection_changes(table_name,row_key,value) SELECT ?,rowid," + values("") + " FROM " + quote(table) + " WHERE true ON CONFLICT(table_name,row_key) DO UPDATE SET seq=excluded.seq,value=excluded.value", table);
      sql.exec("INSERT OR REPLACE INTO admin_projection_tables VALUES (?,?)", table, definition);
    }
    this.installed = true;
    this.changed();
  }

  reset(): void { this.installed = false; this.scoped = false; this.lastInfo = undefined; this.retryAt = undefined; }

  changed(): void {
    if (!this.installed || this.timer !== undefined) return;
    const pending = new Promise<void>(resolve => {
      this.timer = setTimeout(() => { this.timer = undefined; void this.flush().then(resolve, resolve); }, 150);
    });
    this.ctx.waitUntil(pending);
  }

  flush(): Promise<void> {
    const pending = this.flushing ??= this.publish().catch(async () => {
      if (!this.installed) return;
      console.error({ event: "admin_projection_failed" });
      this.retryAt = Date.now() + 5000;
      await this.wake(this.retryAt);
    }).finally(() => {
      this.flushing = undefined;
    });
    return pending.then(() => {
      if (this.installed && this.scoped && this.retryAt === undefined && this.ctx.storage.sql.exec("SELECT 1 FROM admin_projection_changes LIMIT 1").toArray().length) return this.flush();
    });
  }
  private async publish(): Promise<void> {
    if (!this.installed) return;
    const scope = await this.scope();
    if (!scope) return;
    this.scoped = true;
    const sql = this.ctx.storage.sql;
    const readSchemas = () => sql.exec<{ name: ViewTable; columns_json: string }>("SELECT * FROM admin_projection_tables").toArray()
      .map(row => ({ table: row.name, columns: JSON.parse(row.columns_json) as string[] }));
    const maintenance = await this.ctx.storage.get<number>(["maint:aging_last_run", "maint:consolidate_last_run"]);
    const hasTasks = sql.exec("SELECT 1 FROM sqlite_master WHERE name='pi_tasks'").toArray().length;
    const info = { agingLastRun: maintenance.get("maint:aging_last_run") ?? null, consolidateLastRun: maintenance.get("maint:consolidate_last_run") ?? null,
      compacting: !!hasTasks && !!sql.exec("SELECT 1 FROM pi_tasks WHERE kind='pi.compaction' AND status!='terminal' LIMIT 1").toArray().length };
    let changed = false;
    for (;;) {
      const rows = sql.exec<Change>("SELECT * FROM admin_projection_changes ORDER BY seq LIMIT 100").toArray();
      if (!rows.length) break;
      let bytes = 0;
      const changes = rows.filter(row => { if (bytes >= 512_000) return false; bytes += row.value?.length ?? 0; return true; });
      const last = changes.at(-1)!;
      changed = true;
      await this.env.REQUESTS.getByName(viewName(scope)).applyProjection({ scope, schemas: readSchemas(), changes, at: Date.now(), complete: false, info });
      sql.exec("DELETE FROM admin_projection_changes WHERE seq<=?", last.seq);
    }
    if (changed || this.lastInfo !== JSON.stringify(info)) {
      await this.env.REQUESTS.getByName(viewName(scope)).applyProjection({ scope, schemas: readSchemas(), changes: [], at: Date.now(), complete: true, info });
      this.lastInfo = JSON.stringify(info);
    }
    this.retryAt = undefined;
  }
}

export class ProjectionStore {
  readonly db: DurableObjectSqliteDatabase;
  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {
    this.db = new DurableObjectSqliteDatabase(ctx.storage);
    ctx.storage.sql.exec(MEMORY_SUPPORT_SCHEMA);
  }
  status() {
    const exists = this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE name='admin_projection_state'").toArray().length;
    return exists ? this.ctx.storage.sql.exec<{ scope: string; revision: number; synced_at: number; ready: number; info: string }>("SELECT * FROM admin_projection_state WHERE id=1").toArray()[0] : undefined;
  }
  require(scope: string): void {
    const state = this.status();
    if (!state?.ready) throw new Error("view_pending");
    if (state.scope !== scope) throw new Error("view_scope_mismatch");
  }
  apply(batch: ProjectionBatch): void {
    if (!this.ctx.id.equals(this.env.REQUESTS.idFromName(viewName(batch.scope)))) throw new Error("view_scope_mismatch");
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec("CREATE TABLE IF NOT EXISTS admin_projection_state(id INTEGER PRIMARY KEY,scope TEXT NOT NULL,revision INTEGER NOT NULL,synced_at INTEGER NOT NULL,ready INTEGER NOT NULL,info TEXT NOT NULL)");
      const revision = this.status()?.revision ?? 0;
      const schemas = new Map<ViewTable, string[]>();
      for (const schema of batch.schemas) {
        if (!VIEW_TABLES.includes(schema.table) || schema.columns.some(name => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name))) throw new Error("invalid_projection_schema");
        schemas.set(schema.table, schema.columns);
        sql.exec("CREATE TABLE IF NOT EXISTS " + quote(schema.table) + " (" + schema.columns.map(quote).join(",") + ")");
        const current = sql.exec<{ name: string }>("SELECT name FROM pragma_table_info(?)", schema.table).toArray();
        for (const column of schema.columns) if (!current.some(c => c.name === column)) sql.exec("ALTER TABLE " + quote(schema.table) + " ADD COLUMN " + quote(column));
      }
      // 保留列表和关联读取的索引，避免管理查询随历史增长退化成全表扫描。
      const indexes: Partial<Record<ViewTable, string[][]>> = {
        pi_entries: [["conversation_id", "id"]], inbound: [["message_id"], ["platform_message_id", "user_id", "chat_kind", "chat_id"], ["status", "reply_channel"]],
        outbox: [["message_id", "id"]], messages: [["time", "id"]], subagents: [["created_at"]],
        memories: [["ns", "status", "updated_at"]], memory_versions: [["memory_id", "id"]],
        mcp_access: [["scope", "server_id"]], mcp_approvals: [["scope", "created_at"]],
      };
      for (const [table, columns] of schemas) {
        const groups = [...(columns.includes("id") ? [["id"]] : []), ...(indexes[table] ?? [])];
        for (const names of groups) if (names.every(name => columns.includes(name))) {
          sql.exec("CREATE INDEX IF NOT EXISTS " + quote("view_" + table + "_" + names.join("_")) + " ON " + quote(table) + " (" + names.map(quote).join(",") + ")");
        }
      }
      if (schemas.has("memories")) {
        sql.exec("CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(text,subject,content='memories',content_rowid='id',tokenize='trigram'); CREATE TRIGGER IF NOT EXISTS memory_view_insert AFTER INSERT ON memories BEGIN INSERT INTO memories_fts(rowid,text,subject) VALUES(new.id,new.text,new.subject); END; CREATE TRIGGER IF NOT EXISTS memory_view_delete AFTER DELETE ON memories BEGIN INSERT INTO memories_fts(memories_fts,rowid,text,subject) VALUES('delete',old.id,old.text,old.subject); END");
      }
      let latest = revision;
      for (const change of batch.changes) {
        if (change.seq <= revision) continue;
        const columns = schemas.get(change.table_name);
        if (!columns) throw new Error("invalid_projection_table");
        if (change.value === null) sql.exec("DELETE FROM " + quote(change.table_name) + " WHERE rowid=?", change.row_key);
        else {
          const values: unknown = JSON.parse(change.value);
          if (!Array.isArray(values) || values.length !== columns.length || !values.every((value): value is Value => value === null || typeof value === "string" || typeof value === "number")) throw new Error("invalid_projection_row");
          sql.exec("DELETE FROM " + quote(change.table_name) + " WHERE rowid=?", change.row_key);
          sql.exec("INSERT INTO " + quote(change.table_name) + " (rowid," + columns.map(quote).join(",") + ") VALUES (?" + ",?".repeat(values.length) + ")", change.row_key, ...values);
        }
        latest = Math.max(latest, change.seq);
      }
      sql.exec("INSERT OR REPLACE INTO admin_projection_state VALUES (1,?,?,?,?,?)", batch.scope, latest, batch.at, this.status()?.ready || Number(batch.complete), JSON.stringify(batch.info));
    });
  }
}

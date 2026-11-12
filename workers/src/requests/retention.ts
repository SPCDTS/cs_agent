const DAY = 86_400_000;
export const REQUEST_RETENTION = { metadataMs: 30 * DAY, detailsMs: 7 * DAY, maxRequests: 20_000, maxDetailBytes: 32 * 1024 * 1024 };
type Body = { kind: "request" | "tool"; id: string };
type OldBody = { id: string; started: number; bytes: number };
const BATCH = 64;

/** 常规写入只更新计数；索引支持有界逐出，按时间清理由原有 alarm 执行。 */
export class RequestRetention {
  private readonly sql: SqlStorage;
  constructor(storage: DurableObjectStorage) {
    this.sql = storage.sql;
    storage.transactionSync(() => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS request_retention (id INTEGER PRIMARY KEY, request_count INTEGER NOT NULL, detail_bytes INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS request_details_started ON request_details(started,id);
        CREATE INDEX IF NOT EXISTS tool_payload_started ON tool_traces(started,id) WHERE payload IS NOT NULL;`);
      if (!this.sql.exec("SELECT 1 FROM request_retention WHERE id=1").toArray().length) this.sql.exec(`INSERT INTO request_retention
        SELECT 1,(SELECT COUNT(*) FROM requests),
          (SELECT COALESCE(SUM(bytes),0) FROM request_details)+(SELECT COALESCE(SUM(bytes),0) FROM tool_traces);`);
      this.sql.exec(`
        CREATE TRIGGER IF NOT EXISTS request_count_insert AFTER INSERT ON requests BEGIN
          UPDATE request_retention SET request_count=request_count+1 WHERE id=1; END;
        CREATE TRIGGER IF NOT EXISTS request_count_delete AFTER DELETE ON requests BEGIN
          UPDATE request_retention SET request_count=request_count-1 WHERE id=1;
          DELETE FROM request_details WHERE id=OLD.id; END;
        CREATE TRIGGER IF NOT EXISTS detail_bytes_insert AFTER INSERT ON request_details BEGIN
          UPDATE request_retention SET detail_bytes=detail_bytes+NEW.bytes WHERE id=1; END;
        CREATE TRIGGER IF NOT EXISTS detail_bytes_update AFTER UPDATE OF bytes ON request_details BEGIN
          UPDATE request_retention SET detail_bytes=detail_bytes+NEW.bytes-OLD.bytes WHERE id=1; END;
        CREATE TRIGGER IF NOT EXISTS detail_bytes_delete AFTER DELETE ON request_details BEGIN
          UPDATE request_retention SET detail_bytes=detail_bytes-OLD.bytes WHERE id=1; END;
        CREATE TRIGGER IF NOT EXISTS tool_bytes_insert AFTER INSERT ON tool_traces BEGIN
          UPDATE request_retention SET detail_bytes=detail_bytes+NEW.bytes WHERE id=1; END;
        CREATE TRIGGER IF NOT EXISTS tool_bytes_update AFTER UPDATE OF bytes ON tool_traces BEGIN
          UPDATE request_retention SET detail_bytes=detail_bytes+NEW.bytes-OLD.bytes WHERE id=1; END;
        CREATE TRIGGER IF NOT EXISTS tool_bytes_delete AFTER DELETE ON tool_traces BEGIN
          UPDATE request_retention SET detail_bytes=detail_bytes-OLD.bytes WHERE id=1; END;`);
    });
  }
  private stats() {
    return this.sql.exec<{ request_count: number; detail_bytes: number }>("SELECT request_count,detail_bytes FROM request_retention WHERE id=1").one();
  }
  private discard(body: Body) {
    if (body.kind === "request") this.sql.exec("DELETE FROM request_details WHERE id=?", body.id);
    else this.sql.exec("UPDATE tool_traces SET payload=NULL,bytes=0 WHERE id=?", body.id);
  }
  /** 返回是否仍需后续维护；每轮最多逐出64条正文，不在工具续轮路径全量扫描。 */
  trim(incoming?: Body): boolean {
    const counts = this.stats();
    if (counts.request_count > REQUEST_RETENTION.maxRequests) this.sql.exec(
      "DELETE FROM requests WHERE seq IN (SELECT seq FROM requests ORDER BY seq LIMIT ?)", Math.min(BATCH, counts.request_count - REQUEST_RETENTION.maxRequests));
    let bytes = this.stats().detail_bytes;
    if (bytes > REQUEST_RETENTION.maxDetailBytes) {
      const requests = this.sql.exec<OldBody>("SELECT id,started,bytes FROM request_details ORDER BY started,id LIMIT ?", BATCH).toArray();
      const tools = this.sql.exec<OldBody>("SELECT id,started,bytes FROM tool_traces WHERE payload IS NOT NULL ORDER BY started,id LIMIT ?", BATCH).toArray();
      const oldest = [...requests.map(row => ({ ...row, kind: "request" as const })), ...tools.map(row => ({ ...row, kind: "tool" as const }))]
        .sort((a,b) => a.started - b.started || a.id.localeCompare(b.id)).slice(0, BATCH);
      for (const body of oldest) {
        this.discard(body); bytes -= body.bytes;
        if (bytes <= REQUEST_RETENTION.maxDetailBytes) break;
      }
      // 本次写入前处于预算内；极端小正文积压时放弃新正文即可守住上限，元数据仍然可查。
      if (incoming && bytes > REQUEST_RETENTION.maxDetailBytes) this.discard(incoming);
    }
    const remaining = this.stats();
    return remaining.detail_bytes > REQUEST_RETENTION.maxDetailBytes || remaining.request_count > REQUEST_RETENTION.maxRequests;
  }
}

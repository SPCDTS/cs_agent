import type { PiSpan } from "./execution-contracts";

const retention = 7 * 86_400_000;
export class PiStore {
  constructor(private readonly sql: SqlStorage) {}
  exists() {
    return !!this.sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pi_observations'").toArray().length;
  }
  write(spans: PiSpan[]) {
    this.sql
      .exec(`CREATE TABLE IF NOT EXISTS pi_observations(seq INTEGER PRIMARY KEY, id TEXT UNIQUE, actor TEXT, input_id TEXT, ended INTEGER, record TEXT);
      CREATE INDEX IF NOT EXISTS pi_observation_input ON pi_observations(actor,input_id,seq);
      CREATE INDEX IF NOT EXISTS pi_observation_age ON pi_observations(ended)`);
    for (const span of spans)
      this.sql.exec(
        "INSERT OR IGNORE INTO pi_observations(id,actor,input_id,ended,record) VALUES(?,?,?,?,?)",
        span.id,
        span.actor,
        span.inputId,
        span.ended,
        JSON.stringify(span),
      );
    this.trim();
  }
  trim() {
    this.sql.exec("DELETE FROM pi_observations WHERE ended<?", Date.now() - retention);
    this.sql.exec("DELETE FROM pi_observations WHERE seq <= (SELECT MAX(seq)-2048 FROM pi_observations)");
  }
  page(actor: string, input: string, before: number, request?: string) {
    if (!this.exists()) return { spans: [] as PiSpan[] };
    const rows = this.sql
      .exec<{ seq: number; record: string }>(
        `SELECT seq,record FROM pi_observations
      WHERE actor=? AND input_id=? AND seq<? AND ended>=? ${request ? `AND json_extract(record,'$.attrs."request.id"')=?` : ""} ORDER BY seq DESC LIMIT 25`,
        actor,
        input,
        before,
        Date.now() - retention,
        ...(request ? [request] : []),
      )
      .toArray();
    return {
      spans: rows.slice(0, 24).map((r) => JSON.parse(r.record) as PiSpan),
      ...(rows.length > 24 ? { next: rows[23]!.seq } : {}),
    };
  }
  hasRows() {
    return !!this.sql.exec("SELECT 1 FROM pi_observations LIMIT 1").toArray().length;
  }
}

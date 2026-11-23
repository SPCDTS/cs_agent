import { baselineEdges, childAddress, configuredEdge, sessionId } from "./model";

export const EDGE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS agent_edges (from_id TEXT NOT NULL, to_id TEXT NOT NULL, decision TEXT NOT NULL CHECK(decision IN ('allow','deny')), actor TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(from_id,to_id));
  CREATE TABLE IF NOT EXISTS agent_edge_audit (id INTEGER PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, decision TEXT NOT NULL, actor TEXT NOT NULL, updated_at INTEGER NOT NULL);
`;

type Decision = 'allow' | 'deny';
type Row = { from_id: string; to_id: string; decision: Decision; actor: string; updated_at: number };
type View = { from: string; to: string; baseline: boolean; override: Decision | null; effective: boolean | 'parent_lifecycle'; actor?: string; updatedAt?: number };
export class EdgeStore {
  constructor(private storage: DurableObjectStorage, private config?: string) {}
  private row(from: string, to: string) {
    return this.storage.sql.exec<Row>('SELECT * FROM agent_edges WHERE from_id=? AND to_id=?', from, to).toArray()[0];
  }
  allowed(from: string, to: string) {
    const baseline = configuredEdge(this.config, from, to), row = this.row(from, to);
    return from !== to && (row ? row.decision === 'allow' : baseline);
  }
  list() {
    const edges = new Map<string, View>();
    for (const [from, to] of baselineEdges(this.config)) {
      const child = childAddress(from) ?? childAddress(to);
      edges.set(from + '>' + to, { from, to, baseline: true, override: null, effective: from === to ? false : child && (child.parent === from || child.parent === to) ? 'parent_lifecycle' : true });
    }
    for (const row of this.storage.sql.exec<Row>('SELECT * FROM agent_edges ORDER BY from_id,to_id')) {
      const { from_id: from, to_id: to, actor, updated_at: updatedAt, decision } = row, key = from + '>' + to;
      edges.set(key, { from, to, baseline: edges.has(key), override: decision, effective: decision === 'allow', actor, updatedAt });
    }
    return [...edges.values()];
  }
  set(from: string, to: string, decision: Decision, actor: string) {
    sessionId(from); sessionId(to);
    if (from === to || childAddress(from) || childAddress(to) || !['allow','deny'].includes(decision) || !/^qq:[1-9][0-9]{0,19}$/.test(actor)) throw new Error('agent_invalid_edge');
    const baseline = configuredEdge(this.config, from, to);
    return this.storage.transactionSync(() => {
      const sql = this.storage.sql, now = Date.now();
      if (!this.row(from, to) && sql.exec<{n:number}>('SELECT count(*) AS n FROM agent_edges').one().n >= 256) throw new Error('agent_edge_limit');
      sql.exec('INSERT OR REPLACE INTO agent_edges(from_id,to_id,decision,actor,updated_at) VALUES(?,?,?,?,?)', from,to,decision,actor,now);
      sql.exec('INSERT INTO agent_edge_audit(from_id,to_id,decision,actor,updated_at) VALUES(?,?,?,?,?)', from,to,decision,actor,now);
      sql.exec('DELETE FROM agent_edge_audit WHERE id <= (SELECT max(id)-1024 FROM agent_edge_audit)');
      return { from, to, baseline, override: decision, effective: decision === 'allow', actor, updatedAt: now };
    });
  }
}

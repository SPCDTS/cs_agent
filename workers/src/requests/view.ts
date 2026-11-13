import type { SqliteValue } from "@earendil-works/chord/sqlite";
import { ROOT_CONVERSATION_ID, type EntryRecord } from "@earendil-works/pi-durable";
import type { AssetRef } from "../media/repository";
import type { AuditEvent, EventQuery } from "../thread";
import { MemoryManager, type MemoryListQuery, type ProfileProposal } from "../memory/management";
import { MemoryStore, type Profile } from "../memory/store";
import type { MemoryRow } from "../memory/types";
import type { McpApproval, McpGrant } from "../mcp/policy";
import type { SubagentView, SubagentOrigin } from "../subagent/parent";
import { clip, type ParentSubagentStatus, type SubagentIdentity, type SubagentMeta, type SubagentEntry } from "../subagent/model";
import { shortSummary } from "../subagent/activity";
import { historyEntry, historyCursor, readHistoryCursor } from "../sessions";
import { ADMIN_PAGE_SIZE } from "../admin/pagination";
import type { ProjectionStore, ViewInfo } from "./projection";
const EVENT_RESULT_PATH: Record<string, string> = { mcp_call: "$.result", mcp_catalog: "$.status", web_search: "$.result", generate_image: "$.result",
  web_fetch: "$.result", web_import_image: "$.result",
  coding_exec: "$.result", coding_read: "$.result", coding_write: "$.result", coding_edit: "$.result" };

/** 只使用展示数据库；这里没有执行 DO 的绑定或 Harness。 */
export class AgentReadView {
  constructor(private readonly store: ProjectionStore, private readonly scope: string) {}
  private get database() { return this.store.db; }
  private async initialize() { this.store.require(this.scope); }
  private async bindNamespace(ns: string) { if (this.scope !== "thread:" + ns) throw new Error("view_scope_mismatch"); }
  private async adminStore(ns: string) { await this.initialize(); await this.bindNamespace(ns); return new MemoryStore(this.database, ns); }
  private info(): ViewInfo { return JSON.parse(this.store.status()!.info) as ViewInfo; }
  private async maintenanceStatus() {
    const summaries = { day: 0, week: 0 };
    for (const row of await this.database.all<{ kind: "day" | "week"; n: number }>("SELECT kind,COUNT(*) AS n FROM summaries GROUP BY kind")) summaries[row.kind] = row.n;
    const {agingLastRun, consolidateLastRun} = this.info(); return {agingLastRun, consolidateLastRun, summaries};
  }

  async chatView(thread: string, delta?: { after: number; pending: string[] }) {
    await this.initialize();
    await this.bindNamespace(thread);
    type ChatRow = { id: string; role: "user" | "assistant"; source: "qq" | "web"; name: string; text: string; at: number; status: string | null; turnId: string | null; assets_json: string };
    // 投影数值列没有整数类型亲和性；rowid 保留源消息主键，拼接后可原样回传增量查询。
    const rows = await this.database.all<ChatRow>(`
      SELECT * FROM (
        SELECT 'qq:' || m.rowid AS id, CASE WHEN m.is_self=1 THEN 'assistant' ELSE 'user' END AS role,
          'qq' AS source,m.nickname AS name,m.text,m.time * 1000 AS at,i.status,'[]' AS assets_json,
          COALESCE(i.turn_id,(SELECT turn_id FROM outbox WHERE message_id=m.message_id ORDER BY id DESC LIMIT 1)) AS turnId
          FROM messages m LEFT JOIN inbound i ON i.message_id=(SELECT message_id FROM inbound WHERE platform_message_id=m.message_id AND user_id=m.user_id AND chat_kind || ':' || chat_id=m.scope ORDER BY rowid DESC LIMIT 1)
        UNION ALL
        SELECT message_id AS id,'user' AS role,'web' AS source,nickname AS name,text,received_at * 1000 AS at,status,'[]' AS assets_json,turn_id AS turnId
          FROM inbound WHERE reply_channel='web' AND kind='message'
        UNION ALL
        SELECT 'web-out:' || w.id AS id,'assistant' AS role,'web' AS source,'助手' AS name,w.text,w.at,NULL AS status,w.assets_json,i.turn_id AS turnId FROM web_outputs w LEFT JOIN inbound i ON i.message_id=w.input_id
      ) ${delta ? `WHERE at>=?${delta.pending.length ? ` OR id IN (${delta.pending.map(() => "?").join(",")})` : ""}` : ""} ORDER BY at DESC,id DESC LIMIT 100
    `, ...(delta ? [delta.after, ...delta.pending] : []));
    const queued = (await this.database.get<{ n: number }>("SELECT COUNT(*) AS n FROM inbound WHERE status='queued' AND reply_channel='web'"))?.n ?? 0;
    const active = (await this.database.get<{ n: number }>("SELECT COUNT(*) AS n FROM inbound WHERE status='queued'"))?.n ?? 0;
    return { messages: rows.reverse().map(({assets_json,...row})=>({...row,assets:JSON.parse(assets_json) as AssetRef[]})), queued, active, limit: 100, delta: !!delta };
  }

  async stats() {
    await this.initialize();
    const rows = await this.database.all<{ status: "queued" | "done" | "failed"; n: number }>("SELECT status, COUNT(*) AS n FROM inbound GROUP BY status");
    const inbound = { queued: 0, done: 0, failed: 0 };
    for (const row of rows) inbound[row.status] = row.n;
    const out = await this.database.get<{ n: number; last: number | null }>("SELECT COUNT(*) AS n, MAX(sent_at) AS last FROM outbox");
    const active = await this.database.get<{ n: number }>("SELECT COUNT(*) AS n FROM memories WHERE status = 'active'");
    const profile = await this.database.get<{ n: number }>("SELECT COALESCE(SUM(length(CAST(text AS BLOB))), 0) AS n FROM profile");
    const queue = await this.database.get<{ n: number }>("SELECT COUNT(*) AS n FROM extract_queue");
    return { inbound, outbox: out?.n ?? 0, ...(out?.last ? { lastSentAt: out.last } : {}), subagents: { running: (await this.database.get<{ n: number }>("SELECT COUNT(*) AS n FROM subagents WHERE status='running'"))?.n ?? 0 },
      memory: { active: active?.n ?? 0, profileBytes: profile?.n ?? 0, extractQueue: queue?.n ?? 0 },
      maintenance: await this.maintenanceStatus() };
  }

  async events(q: EventQuery): Promise<{ events: AuditEvent[]; next?: number }> {
    await this.initialize();
    const where: string[] = [], args: SqliteValue[] = [];
    if (q.kind) { where.push("kind = ?"); args.push(q.kind); }
    if (q.result) {
      where.push(`CASE kind ${Object.keys(EVENT_RESULT_PATH).map(() => "WHEN ? THEN json_extract(detail, ?) = ?").join(" ")} ELSE 1 END`);
      for (const [kind, path] of Object.entries(EVENT_RESULT_PATH)) args.push(kind, path, q.result);
    }
    if (q.before !== undefined) { where.push("rowid < ?"); args.push(q.before); }
    const limit = Math.min(200, Math.max(1, Math.trunc(q.limit)));
    const rows = await this.database.all<{ id: number; at: number; kind: string; detail: string }>(
      `SELECT rowid AS id, at, kind, detail FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY rowid DESC LIMIT ?`, ...args, limit + 1);
    const events = rows.slice(0, limit).map((row): AuditEvent => ({ id: row.id, at: row.at, kind: row.kind, detail: JSON.parse(row.detail) }));
    return rows.length > limit ? { events, next: events[events.length - 1].id } : { events };
  }

  async memoryCandidates(ns: string) { return new MemoryManager(await this.adminStore(ns)).candidates(); }
  async memoryList(ns: string, query: MemoryListQuery): ReturnType<MemoryManager["list"]> {
    return new MemoryManager(await this.adminStore(ns)).list(query);
  }

  async memoryDetail(ns: string, id: number): ReturnType<MemoryManager["detail"]> {
    return new MemoryManager(await this.adminStore(ns)).detail(id);
  }

  async memoryJobs(ns: string): ReturnType<MemoryManager["jobs"]> {
    return new MemoryManager(await this.adminStore(ns)).jobs();
  }

  async memoryProposals(ns: string, status: ProfileProposal["status"] | "all"): ReturnType<MemoryManager["proposals"]> {
    return new MemoryManager(await this.adminStore(ns)).proposals(status);
  }

  async memoryView(ns: string, query: string): Promise<{ profile: Profile; memories: MemoryRow[] }> {
    const store = await this.adminStore(ns), q = query.trim(), id = /^#(\d{1,15})$/.exec(q);
    const memories = id ? [await store.get(Number(id[1]))].filter(row => row !== undefined)
      : q ? await store.search({ query: q, limit: 20 }) : await store.recent(50);
    return { profile: await store.profile(), memories };
  }

  async mcpToolCounts(): Promise<Record<string, number>> {
    await this.initialize();
    const rows = await this.database.all<{ server_id: string; n: number }>("SELECT server_id, COUNT(*) AS n FROM mcp_catalog GROUP BY server_id");
    return Object.fromEntries(rows.map(row => [row.server_id, row.n]));
  }

  async mcpAccess(scope: string, server: string): Promise<McpGrant | null> {
    await this.initialize(); await this.bindNamespace(scope);
    const row = await this.database.get<{ value_json: string }>("SELECT value_json FROM mcp_access WHERE scope=? AND server_id=?",scope,server);
    return row ? JSON.parse(row.value_json) as McpGrant : null;
  }
  async mcpApprovals(scope: string): Promise<McpApproval[]> {
    await this.initialize(); await this.bindNamespace(scope);
    const rows = await this.database.all<McpApproval>("SELECT * FROM mcp_approvals WHERE scope=? ORDER BY created_at DESC LIMIT 100",scope);
    return rows.map(row => row.expires_at <= Date.now() && ["pending","approved"].includes(row.status) ? {...row,status:"expired"} : row);
  }
  async child(id: string) {
    await this.initialize();
    return this.database.get<{id:string;task:string;summary:string|null;status:ParentSubagentStatus;created_at:number;deadline:number;ended_at:number|null;last_report_at:number|null;identity_json:string;origin_json:string}>("SELECT * FROM subagents WHERE id=?",id);
  }
  async subagentList(activity: Record<string, number>): Promise<(SubagentView & {lastActiveAt: number})[]> {
    await this.initialize();
    const ids = await this.database.all<{id:string;last_active_at:number}>(`SELECT subagents.id,
      MAX(created_at,COALESCE(last_report_at,0),COALESCE(ended_at,0),COALESCE(activity.value,0)) AS last_active_at
      FROM subagents LEFT JOIN json_each(?) AS activity ON activity.key=subagents.id
      ORDER BY last_active_at DESC,created_at DESC,subagents.id LIMIT 50`,JSON.stringify(activity));
    const items: (SubagentView & {lastActiveAt: number})[]=[];
    for (const {id,last_active_at} of ids) { const row=await this.child(id); if(!row)continue;
      const as=(JSON.parse(row.identity_json) as SubagentIdentity).as, sandboxId=(JSON.parse(row.origin_json) as SubagentOrigin).capabilities?.sandboxId;
      items.push({id,lastActiveAt:last_active_at,task:clip(row.task,200),summary:row.summary??shortSummary(row.task),status:row.status,createdAt:row.created_at,deadline:row.deadline||null,
        ...(sandboxId?{sandboxId}:{}),...(as?{spawner:(as.owner?"owner":"成员")+" "+as.userId}:{}),
        ...(row.ended_at===null?{}:{endedAt:row.ended_at}),...(row.last_report_at===null?{}:{lastReportAt:row.last_report_at})});
    }
    return items;
  }
  async sessionHistory(thread: string, cursor?: string) {
    await this.initialize();await this.bindNamespace(thread);
    return {...await this.modelHistory(cursor),
      busy:!!await this.database.get("SELECT 1 FROM inbound WHERE status='queued' LIMIT 1"),compacting:this.info().compacting};
  }
  async subagentConversation(cursor?: string) {
    await this.initialize();
    const row=await this.database.get<{value:string}>("SELECT value FROM meta WHERE key='subagent'");
    if(!row)throw new Error("view_pending");
    const meta=JSON.parse(row.value) as SubagentMeta;
    return {...await this.modelHistory(cursor,"chat"),status:meta.status,summary:meta.summary??shortSummary(meta.task),syncedAt:this.store.status()!.synced_at};
  }
  async modelHistory(cursor?: string, format: "history" | "chat" = "history") {
    await this.initialize();
    const c=readHistoryCursor(cursor),after=c?.after;
    if(after!==undefined&&(typeof after!=="number"||!Number.isSafeInteger(after)))throw new Error("invalid_cursor");
    if(c&&(after===undefined||(c.order!==undefined&&c.order!=="descending")))throw new Error("invalid_cursor");
    const hasEntries=await this.database.get("SELECT 1 FROM sqlite_master WHERE name='pi_entries'");
    const rows=hasEntries?await this.database.all<{record:string}>("SELECT record FROM pi_entries WHERE conversation_id=? AND id<? ORDER BY id DESC LIMIT ?",ROOT_CONVERSATION_ID,after??Number.MAX_SAFE_INTEGER,ADMIN_PAGE_SIZE+1):[];
    const entries=rows.slice(0,ADMIN_PAGE_SIZE).map(row=>historyEntry(JSON.parse(row.record) as EntryRecord,format));
    return {entries,next:rows.length>ADMIN_PAGE_SIZE?historyCursor({after:entries.at(-1)!.id,order:"descending"}):undefined};
  }
  async transcriptSummary(limit: number): Promise<{meta:SubagentMeta;entries:SubagentEntry[]}|undefined> {
    await this.initialize();
    const row=await this.database.get<{value:string}>("SELECT value FROM meta WHERE key='subagent'");if(!row)return;
    const meta=JSON.parse(row.value) as SubagentMeta;
    const hasEntries=await this.database.get("SELECT 1 FROM sqlite_master WHERE name='pi_entries'");
    const rows=hasEntries?await this.database.all<{record:string}>("SELECT record FROM pi_entries WHERE conversation_id=? ORDER BY id DESC LIMIT ?",ROOT_CONVERSATION_ID,Math.min(50,Math.max(1,Math.trunc(limit)))):[];
    return {meta,entries:rows.map(row=>{const entry=JSON.parse(row.record) as EntryRecord;
      return {id:Number(entry.id),kind:entry.kind,...(entry.model?.[0]?{role:entry.model[0].role}:{}),text:(entry.model??[]).flatMap(message=>typeof message.content==="string"?[message.content]:message.content.flatMap(block=>block.type==="text"?[block.text]:block.type==="toolCall"?["["+block.name+"]"]:[])).join(" ").slice(0,200)};})};
  }
  async workspaceChild(thread: string,id: string) {
    const row=await this.child(id);if(!row||thread!=="owner")throw new Error("workspace_denied");
    const origin=JSON.parse(row.origin_json) as SubagentOrigin,identity=JSON.parse(row.identity_json) as SubagentIdentity;
    const generation=(await this.database.get<{generation:number}>("SELECT generation FROM session_state WHERE id=1"))?.generation??0;
    if(origin.generation!==generation||!origin.capabilities?.coding||!identity.as?.owner)throw new Error("workspace_denied");
    return {sandboxId:origin.capabilities.sandboxId};
  }
}

import { Type, type Static } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import { MEMORY_KINDS, MEMORY_STATUSES, isMemoryNs, type MemoryRow } from "./types";
import { MemoryStore, memoryHash, nowSec, sha256 } from "./store";
import { containsSecret } from "./secrets";

const id = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const sec = Type.Integer({ minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER });
const nullable = <T extends ReturnType<typeof Type.String> | typeof sec>(schema: T) => Type.Union([schema, Type.Null()]);
export const MemorySnapshotSchema = Type.Object({
  id, ns: Type.String(), kind: Type.Union(MEMORY_KINDS.map(k => Type.Literal(k))),
  subject: nullable(Type.String({ maxLength: 40 })), text: Type.String({ minLength: 1, maxLength: 500 }),
  since: nullable(sec), until: nullable(sec), due_at: nullable(sec), done_at: nullable(sec),
  status: Type.Union(MEMORY_STATUSES.map(s => Type.Literal(s))), author: Type.String({ minLength: 1, maxLength: 100 }),
  source_scope: nullable(Type.String({ maxLength: 200 })), source_message_id: nullable(Type.String({ maxLength: 200 })), source_turn_id: nullable(Type.String({ maxLength: 200 })),
  confidence: Type.Number({ minimum: 0, maximum: 1 }), created_at: sec, updated_at: sec, last_recalled_at: nullable(sec),
  recall_count: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), hash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
}, { additionalProperties: false });
const VersionSchema = Type.Object({ id, memory_id: id, at: sec, by: Type.String({ minLength: 1, maxLength: 200 }),
  before_json: nullable(Type.String()), after_json: Type.String(), reason: nullable(Type.String({ maxLength: 500 })) }, { additionalProperties: false });
const LinkSchema = Type.Object({ from_id: id, to_id: id, rel: Type.Union([Type.Literal("related"), Type.Literal("supersedes")]), created_at: sec }, { additionalProperties: false });
const ProposalSchema = Type.Object({ id, ns: Type.String(), text: Type.String(), based_on_revision: Type.String({ maxLength: 64 }),
  batch_id: Type.String({ maxLength: 200 }), created_at: sec, entries_hash: nullable(Type.String({ maxLength: 128 })),
  status: Type.Union([Type.Literal("pending"), Type.Literal("accepted"), Type.Literal("rejected")]),
  decided_at: nullable(sec), applied_revision: nullable(Type.String({ maxLength: 64 })) }, { additionalProperties: false });
export const MemoryHistorySchema = Type.Object({
  format: Type.Literal("cs-agent-memory-history-v1"), source: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$" }), ns: Type.String(),
  memories: Type.Array(MemorySnapshotSchema, { maxItems: 10000 }), versions: Type.Array(VersionSchema, { maxItems: 100000 }),
  links: Type.Array(LinkSchema, { maxItems: 50000 }), proposals: Type.Array(ProposalSchema, { maxItems: 10000 }),
}, { additionalProperties: false });
export type MemoryHistoryImport = Static<typeof MemoryHistorySchema>;
export const MEMORY_HISTORY_MAX_BYTES = 32 * 1024 * 1024;

function validSnapshot(value: unknown, ns: string, memoryId: number): MemoryRow {
  if (!Check(MemorySnapshotSchema, value) || value.ns !== ns || value.id !== memoryId || !value.text.trim()
    || Object.values(value).some(v => typeof v === "string" && containsSecret(v))) throw new Error("invalid_history_snapshot");
  return value;
}
export function parseSnapshot(raw: string, ns: string, memoryId: number): MemoryRow {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("invalid_history_snapshot"); }
  return validSnapshot(value, ns, memoryId);
}
export function parseMemoryHistory(value: unknown): MemoryHistoryImport {
  if (!Check(MemoryHistorySchema, value) || !isMemoryNs(value.ns)) throw new Error("invalid_memory_history");
  const ids = new Set<number>();
  for (const row of value.memories) {
    validSnapshot(row, value.ns, row.id);
    if (ids.has(row.id)) throw new Error("duplicate_history_id");
    ids.add(row.id);
  }
  const versionIds = new Set<number>(), proposalIds = new Set<number>(), links = new Set<string>();
  for (const version of value.versions) {
    if (!ids.has(version.memory_id) || versionIds.has(version.id)) throw new Error("invalid_history_reference");
    versionIds.add(version.id);
    if (version.before_json !== null) parseSnapshot(version.before_json, value.ns, version.memory_id);
    parseSnapshot(version.after_json, value.ns, version.memory_id);
    if (containsSecret(version.by) || version.reason && containsSecret(version.reason)) throw new Error("invalid_memory_history");
  }
  for (const link of value.links) {
    const key = `${link.from_id}:${link.to_id}:${link.rel}`;
    if (!ids.has(link.from_id) || !ids.has(link.to_id) || links.has(key)) throw new Error("invalid_history_reference");
    links.add(key);
  }
  for (const proposal of value.proposals) {
    if (proposal.ns !== value.ns || proposalIds.has(proposal.id) || !proposal.text.trim()
      || new TextEncoder().encode(proposal.text).byteLength > 4096 || containsSecret(proposal.text)) throw new Error("invalid_history_proposal");
    proposalIds.add(proposal.id);
  }
  return value;
}

/** 单事务增量导入；旧版本的顺序和来源保留，绝不把旧快照覆写到已存在的云端当前条目。 */
export async function importMemoryHistory(store: MemoryStore, value: unknown, options: { dryRun?: boolean } = {}) {
  const data = parseMemoryHistory(value);
  if (data.ns !== store.ns) throw new Error("namespace_mismatch");
  return store.db.transaction(async tx => {
    const result = { source: data.source, ns: data.ns, dryRun: options.dryRun === true, memories: 0, versions: 0, links: 0, proposals: 0, skipped: 0,
      idMap: [] as { legacyId: number; memoryId: number }[] };
    const mapped = new Map<number, number>(), reserved = new Set<number>();
    const now = nowSec();
    let simulatedId = (await tx.get<{ n: number }>("SELECT COALESCE(MAX(id),0) AS n FROM memories"))?.n ?? 0;
    const receipt = async (kind: string, legacyId: string, dataValue: unknown) => {
      const digest = sha256(JSON.stringify(dataValue));
      const previous = await tx.get<{ digest: string }>("SELECT digest FROM memory_history_receipts WHERE source = ? AND ns = ? AND kind = ? AND legacy_id = ?", data.source, data.ns, kind, legacyId);
      if (previous) {
        if (previous.digest !== digest && kind !== "memory") throw new Error("history_receipt_conflict");
        result.skipped++; return false;
      }
      if (!options.dryRun) await tx.run("INSERT INTO memory_history_receipts(source,ns,kind,legacy_id,digest,imported_at) VALUES (?,?,?,?,?,?)", data.source, data.ns, kind, legacyId, digest, now);
      return true;
    };
    for (const input of data.memories) {
      const previous = await tx.get<{ memory_id: number }>("SELECT memory_id FROM memory_history_map WHERE source = ? AND ns = ? AND legacy_id = ?", data.source, data.ns, input.id);
      let memoryId = previous?.memory_id;
      if (memoryId !== undefined) {
        if (!await store.get(memoryId, tx)) throw new Error("history_mapping_missing");
        await receipt("memory", String(input.id), input);
      } else {
        const occupied = await tx.get<MemoryRow>("SELECT * FROM memories WHERE id = ?", input.id);
        const same = occupied?.ns === data.ns && (occupied.hash === memoryHash(data.ns, input.kind, input.text)
          || input.source_message_id !== null && occupied.created_at === input.created_at && occupied.author === input.author
            && occupied.source_scope === input.source_scope && occupied.source_message_id === input.source_message_id
            && occupied.source_turn_id === input.source_turn_id);
        memoryId = same ? input.id : occupied || reserved.has(input.id) ? ++simulatedId : input.id;
        simulatedId = Math.max(simulatedId, memoryId);
        if (!same) {
          result.memories++;
          if (!options.dryRun) {
            const row = { ...input, id: memoryId, hash: memoryHash(data.ns, input.kind, input.text) };
            const keys = Object.keys(row);
            await tx.run(`INSERT INTO memories (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`, ...Object.values(row));
            await tx.run("INSERT INTO memory_versions(memory_id,at,by,before_json,after_json,reason) VALUES (?,?,?,NULL,?,?)",
              memoryId, now, "import-history", JSON.stringify(row), "import_history_current");
          }
        }
        if (!options.dryRun) await tx.run("INSERT INTO memory_history_map(source,ns,legacy_id,memory_id) VALUES (?,?,?,?)", data.source, data.ns, input.id, memoryId);
        await receipt("memory", String(input.id), input);
      }
      reserved.add(memoryId);
      mapped.set(input.id, memoryId);
      result.idMap.push({ legacyId: input.id, memoryId });
    }
    const remap = (legacyId: number) => {
      const memoryId = mapped.get(legacyId);
      if (memoryId === undefined) throw new Error("invalid_history_reference");
      return memoryId;
    };
    const snapshot = (raw: string, legacyId: number) => JSON.stringify({ ...parseSnapshot(raw, data.ns, legacyId), id: remap(legacyId) });
    for (const version of [...data.versions].sort((a, b) => a.id - b.id)) {
      if (!await receipt("version", String(version.id), version)) continue;
      result.versions++;
      if (!options.dryRun) {
        const inserted = await tx.get<{ id: number }>("INSERT INTO memory_versions(memory_id,at,by,before_json,after_json,reason) VALUES (?,?,?,?,?,?) RETURNING id",
          remap(version.memory_id), version.at, version.by, version.before_json === null ? null : snapshot(version.before_json, version.memory_id),
          snapshot(version.after_json, version.memory_id), version.reason);
        if (!inserted) throw new Error("history_version_insert_failed");
        await tx.run("INSERT INTO memory_imported_versions(version_id) VALUES (?)", inserted.id);
      }
    }
    for (const link of data.links) {
      if (!await receipt("link", `${link.from_id}:${link.to_id}:${link.rel}`, link)) continue;
      result.links++;
      if (!options.dryRun) await tx.run("INSERT OR IGNORE INTO memory_links(from_id,to_id,rel,created_at) VALUES (?,?,?,?)", remap(link.from_id), remap(link.to_id), link.rel, link.created_at);
    }
    for (const proposal of data.proposals) {
      if (!await receipt("proposal", String(proposal.id), proposal)) continue;
      result.proposals++;
      if (!options.dryRun) await tx.run(`INSERT INTO memory_proposals(ns,text,based_on_revision,batch_id,created_at,entries_hash,status,decided_at,applied_revision)
        VALUES (?,?,?,?,?,?,?,?,?)`, data.ns, proposal.text, proposal.based_on_revision, proposal.batch_id, proposal.created_at, proposal.entries_hash ?? "",
        proposal.status, proposal.decided_at, proposal.applied_revision);
    }
    return result;
  });
}

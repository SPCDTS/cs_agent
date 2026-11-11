import { ADMIN_PAGE_SIZE } from "./pagination";
import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import type { AdminContext, AdminRoute } from "./routes";
import { MemoryAdminError, type MemoryListQuery, type MemoryManager, type ProfileProposal } from "../memory/management";
import { MEMORY_KINDS, MEMORY_STATUSES, isMemoryNs } from "../memory/types";
import { MEMORY_HISTORY_MAX_BYTES, parseMemoryHistory, type importMemoryHistory } from "../memory/history-import";
import type { generateProfileProposal } from "../maintenance/profile-proposal";
import type { runConsolidate } from "../maintenance/consolidate";

/** ThreadDO 只需按下列签名转发到同一 SQLite 内的 manager / maintenance。 */
export interface MemoryAdminRpc {
  memoryList(ns: string, query: MemoryListQuery): ReturnType<MemoryManager["list"]>;
  memoryDetail(ns: string, id: number): ReturnType<MemoryManager["detail"]>;
  restoreMemory(ns: string, id: number, options: { expectedVersion: number; versionId?: number }): ReturnType<MemoryManager["restore"]>;
  memoryJobs(ns: string): ReturnType<MemoryManager["jobs"]>;
  consolidateMemory(ns: string): ReturnType<typeof runConsolidate>;
  rollbackMemory(ns: string, batchId: string): ReturnType<MemoryManager["rollback"]>;
  memoryProposals(ns: string, status: ProfileProposal["status"] | "all"): ReturnType<MemoryManager["proposals"]>;
  generateMemoryProposal(ns: string): ReturnType<typeof generateProfileProposal>;
  decideMemoryProposal(ns: string, id: number, decision: "accepted" | "rejected", expectedRevision: string): ReturnType<MemoryManager["decideProposal"]>;
  importMemoryHistory(ns: string, data: unknown, options: { dryRun?: boolean }): ReturnType<typeof importMemoryHistory>;
}
const strict = { additionalProperties: false } as const;
const ID = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const RESTORE = Type.Object({ expectedVersion: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), versionId: Type.Optional(ID) }, strict);
const DECISION = Type.Object({ expectedRevision: Type.String({ minLength: 1, maxLength: 64 }) }, strict);
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
function nsFrom(ctx: AdminContext) {
  const ns = ctx.url.searchParams.get("ns");
  if (!isMemoryNs(ns)) throw new MemoryAdminError("invalid");
  return ns;
}
async function body<T extends TSchema>(request: Request, schema: T): Promise<Static<T>> {
  let value: unknown;
  try { value = await request.json(); } catch { throw new MemoryAdminError("invalid"); }
  if (!Check(schema, value)) throw new MemoryAdminError("invalid");
  return value;
}
function query(url: URL): MemoryListQuery {
  const params = url.searchParams, value = (key: string) => params.get(key) ?? undefined;
  const readInt = (key: string, minimum: number, maximum: number) => {
    const raw = value(key);
    if (raw === undefined) return undefined;
    if (!/^[0-9]{1,16}$/.test(raw)) throw new MemoryAdminError("invalid");
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < minimum || n > maximum) throw new MemoryAdminError("invalid");
    return n;
  };
  const parsed: unknown = { query: value("q"), status: value("status"), kind: value("kind"),
    cursor: readInt("cursor", 1, Number.MAX_SAFE_INTEGER), page: readInt("page", 1, 1000000), limit: readInt("limit", 1, 100) ?? ADMIN_PAGE_SIZE };
  const schema = Type.Object({
    query: Type.Optional(Type.String({ maxLength: 200 })), status: Type.Optional(Type.Union([...MEMORY_STATUSES.map(v => Type.Literal(v)), Type.Literal("all")])),
    kind: Type.Optional(Type.Union(MEMORY_KINDS.map(v => Type.Literal(v)))), cursor: Type.Optional(ID), page: Type.Optional(ID), limit: Type.Optional(ID),
  }, strict);
  if (!Check(schema, parsed)) throw new MemoryAdminError("invalid");
  return parsed;
}

/** 放在旧 memory 路由之前；所有路由由现有 handleAdmin 统一执行 Bearer 鉴权。 */
export function createMemoryAdminRoutes(resolve: (ctx: AdminContext, ns: string) => MemoryAdminRpc, read: (ctx: AdminContext, ns: string) => Pick<MemoryAdminRpc, "memoryList" | "memoryDetail" | "memoryJobs" | "memoryProposals"> = resolve): AdminRoute[] {
  const guarded = (handle: AdminRoute["handle"]): AdminRoute["handle"] => async ctx => {
    try { return await handle(ctx); }
    catch (error) {
      // RPC 跨 isolate 时自定义 Error 的原型可能被擦除，Thread 应保留可识别的短错误分类。
      if (error instanceof MemoryAdminError) return json({ error: error.code }, error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 400);
      if (error instanceof Error && /^memory_admin:(not_found|conflict|invalid)$/.test(error.message)) {
        const code = error.message.slice("memory_admin:".length);
        return json({ error: code }, code === "not_found" ? 404 : code === "conflict" ? 409 : 400);
      }
      if (error instanceof Error && ["invalid_memory_history", "invalid_history_snapshot", "invalid_history_reference", "invalid_history_proposal", "duplicate_history_id", "history_receipt_conflict", "namespace_mismatch"].includes(error.message)) {
        return json({ error: error.message }, error.message === "history_receipt_conflict" ? 409 : 400);
      }
      throw error;
    }
  };
  return [
    { method: "GET", path: "/admin/memory/list", handle: guarded(async ctx => {
      const ns = nsFrom(ctx), parsed = query(ctx.url); return json(await read(ctx, ns).memoryList(ns, parsed));
    }) },
    { method: "GET", path: /^\/admin\/memory\/(?<id>[1-9]\d{0,14})$/, handle: guarded(async ctx => {
      const ns = nsFrom(ctx); return json(await read(ctx, ns).memoryDetail(ns, Number(ctx.params.id)));
    }) },
    { method: "POST", path: /^\/admin\/memory\/(?<id>[1-9]\d{0,14})\/restore$/, handle: guarded(async ctx => {
      const ns = nsFrom(ctx); return json(await resolve(ctx, ns).restoreMemory(ns, Number(ctx.params.id), await body(ctx.request, RESTORE)));
    }) },
    { method: "GET", path: "/admin/memory/jobs", handle: guarded(async ctx => {
      const ns = nsFrom(ctx); return json({ jobs: await read(ctx, ns).memoryJobs(ns) });
    }) },
    { method: "POST", path: "/admin/memory/consolidate", handle: guarded(async ctx => {
      const ns = nsFrom(ctx); return json(await resolve(ctx, ns).consolidateMemory(ns));
    }) },
    { method: "POST", path: /^\/admin\/memory\/jobs\/(?<batchId>[0-9a-f-]{36})\/rollback$/, handle: guarded(async ctx => {
      const ns = nsFrom(ctx); return json(await resolve(ctx, ns).rollbackMemory(ns, ctx.params.batchId!));
    }) },
    { method: "GET", path: "/admin/memory/proposals", handle: guarded(async ctx => {
      const ns = nsFrom(ctx), status = ctx.url.searchParams.get("status") ?? "pending";
      if (status !== "pending" && status !== "accepted" && status !== "rejected" && status !== "all") throw new MemoryAdminError("invalid");
      return json({ proposals: await read(ctx, ns).memoryProposals(ns, status) });
    }) },
    { method: "POST", path: "/admin/memory/proposals", handle: guarded(async ctx => {
      const ns = nsFrom(ctx); return json(await resolve(ctx, ns).generateMemoryProposal(ns));
    }) },
    { method: "POST", path: /^\/admin\/memory\/proposals\/(?<id>[1-9]\d{0,14})\/(?<decision>accept|reject)$/, handle: guarded(async ctx => {
      const ns = nsFrom(ctx), input = await body(ctx.request, DECISION);
      return json(await resolve(ctx, ns).decideMemoryProposal(ns, Number(ctx.params.id), ctx.params.decision === "accept" ? "accepted" : "rejected", input.expectedRevision));
    }) },
    { method: "POST", path: "/admin/memory/history/import", handle: guarded(async ctx => {
      if (Number(ctx.request.headers.get("Content-Length") ?? 0) > MEMORY_HISTORY_MAX_BYTES) return json({ error: "too_large" }, 413);
      const raw = await ctx.request.arrayBuffer();
      if (raw.byteLength > MEMORY_HISTORY_MAX_BYTES) return json({ error: "too_large" }, 413);
      let value: unknown;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw)); } catch { throw new MemoryAdminError("invalid"); }
      const envelope = Type.Object({ data: Type.Unknown(), dryRun: Type.Optional(Type.Boolean()) }, strict);
      if (!Check(envelope, value)) throw new MemoryAdminError("invalid");
      const data = parseMemoryHistory(value.data);
      return json(await resolve(ctx, data.ns).importMemoryHistory(data.ns, data, { dryRun: value.dryRun }));
    }) },
  ];
}

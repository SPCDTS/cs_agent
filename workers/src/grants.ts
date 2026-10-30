import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { ownerIds } from "./policy";

const strict = { additionalProperties: false };
export const GrantCapSchema = Type.Union([Type.Literal("send"), Type.Literal("schedule")]);
const UserSchema = Type.String({ pattern: "^qq:[1-9][0-9]{0,19}$" });
const ScopeSchema = Type.String({ pattern: "^(group|private):[1-9][0-9]{0,19}$" });
const TargetSchema = Type.String({ pattern: "^qq:(group|private):[1-9][0-9]{0,19}$" });
export const GrantInputSchema = Type.Object({ user: UserSchema, caps: Type.Array(GrantCapSchema, { minItems: 1, maxItems: 2, uniqueItems: true }),
  targets: Type.Optional(Type.Array(TargetSchema, { maxItems: 200, uniqueItems: true })),
  scopes: Type.Optional(Type.Array(ScopeSchema, { maxItems: 200, uniqueItems: true })),
  expires_in_hours: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 876000 })),
}, strict);
export const GrantRevokeSchema = Type.Object({ user: UserSchema, caps: Type.Optional(Type.Array(GrantCapSchema, { minItems: 1, maxItems: 2, uniqueItems: true })) }, strict);
export const GrantSchema = Type.Object({ user: UserSchema, caps: Type.Array(GrantCapSchema, { minItems: 1, maxItems: 2, uniqueItems: true }),
  targets: Type.Array(TargetSchema, { maxItems: 200, uniqueItems: true }), scopes: Type.Optional(Type.Array(ScopeSchema, { maxItems: 200, uniqueItems: true })),
  expires_at: Type.Optional(Type.Integer({ minimum: 0 })), granted_by: UserSchema,
  created_at: Type.Integer({ minimum: 0 }), updated_at: Type.Integer({ minimum: 0 }),
}, strict);
export const GrantImportSchema = Type.Object({ datasetId: Type.String({ minLength: 1, maxLength: 128 }), sourceHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  schemaVersion: Type.Literal(1), dryRun: Type.Boolean(), grants: Type.Array(GrantSchema, { maxItems: 1000 }) }, strict);
export const GrantImportReceiptSchema = Type.Object({datasetId:Type.String(),sourceHash:Type.String(),dryRun:Type.Boolean(),items:Type.Array(Type.Object({user:Type.String(),action:Type.Union([Type.Literal("created"),Type.Literal("preserved")])},strict))},strict);
export type GrantImportResult = Static<typeof GrantImportReceiptSchema> & { replayed:boolean };
export type GrantInput = Static<typeof GrantInputSchema>;
export type Grant = Static<typeof GrantSchema>;
export type GrantAccess = { user: string; cap: Static<typeof GrantCapSchema>; scope: string; target?: string };
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** 授权撤销保留用户修订墓碑；旧导入不能在撤权后再次创建同一授权。 */
export class GrantStore {
  constructor(private readonly storage: DurableObjectStorage, private readonly env: { QQ_OWNER?: string }) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS grants (user TEXT PRIMARY KEY, value TEXT, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS grant_imports (dataset TEXT NOT NULL, source_hash TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(dataset,source_hash));`);
  }
  list(now = Date.now()): (Grant & { expired: boolean; revision: number })[] {
    return this.storage.sql.exec<{ value: string; revision: number }>("SELECT value,revision FROM grants WHERE value IS NOT NULL ORDER BY user").toArray().map(row => {
      const value: unknown = JSON.parse(row.value);
      if (!Check(GrantSchema, value)) throw new Error("invalid_stored_grant");
      return { ...value, revision: row.revision, expired: value.expires_at !== undefined && value.expires_at <= now };
    });
  }
  put(input: unknown, actor: string, now = Date.now()): Grant {
    if (!Check(GrantInputSchema, input)) throw new Error("invalid_grant");
    const before = this.list(now).find(grant => grant.user === input.user);
    const grant: Grant = { user: input.user, caps: input.caps, targets: input.targets ?? [], ...(input.scopes ? { scopes: input.scopes } : {}),
      ...(input.expires_in_hours === undefined ? {} : { expires_at: now + input.expires_in_hours * 3600000 }),
      granted_by: actor, created_at: before?.created_at ?? now, updated_at: now };
    if (!Check(UserSchema, actor)) throw new Error("invalid_actor");
    this.save(grant);
    return grant;
  }
  revoke(input: unknown, now = Date.now()): Grant | null {
    if (!Check(GrantRevokeSchema, input)) throw new Error("invalid_revoke");
    const before = this.list(now).find(grant => grant.user === input.user);
    const caps = input.caps ? before?.caps.filter(cap => !input.caps?.includes(cap)) ?? [] : [];
    if (before && caps.length) {
      const { expired: _expired, revision: _revision, ...grant } = before;
      const after = { ...grant, caps, updated_at: now }; this.save(after); return after;
    }
    this.storage.sql.exec(`INSERT INTO grants(user,value,revision) VALUES (?,NULL,1)
      ON CONFLICT(user) DO UPDATE SET value=NULL,revision=revision+1`, input.user);
    return null;
  }
  canAccess(input: GrantAccess, now = Date.now()): boolean {
    if (!Check(UserSchema, input.user) || !Check(GrantCapSchema, input.cap) || !Check(ScopeSchema, input.scope)) return false;
    if (ownerIds(this.env).includes(input.user.slice(3))) return true;
    const grant = this.list(now).find(grant => grant.user === input.user && !grant.expired);
    return !!grant && grant.caps.includes(input.cap) && (grant.scopes === undefined || grant.scopes.includes(input.scope))
      && (input.cap !== "send" || input.target !== undefined && grant.targets.includes(input.target));
  }
  import(input: unknown):GrantImportResult {
    if (!Check(GrantImportSchema, input)) throw new Error("invalid_grant_import");
    if (new Set(input.grants.map(grant => grant.user)).size !== input.grants.length) throw new Error("duplicate_import_user");
    return this.storage.transactionSync(() => {
      const receipt = this.storage.sql.exec<{ receipt: string }>("SELECT receipt FROM grant_imports WHERE dataset=? AND source_hash=?", input.datasetId, input.sourceHash).toArray()[0];
      if (receipt) { const value:unknown=JSON.parse(receipt.receipt);if(!Check(GrantImportReceiptSchema,value))throw new Error("invalid_grant_receipt");return { replayed:true,...value }; }
      const items:GrantImportResult["items"] = input.grants.map(grant => ({ user: grant.user, action: this.storage.sql.exec("SELECT user FROM grants WHERE user=?", grant.user).toArray().length ? "preserved" : "created" }));
      const result = { datasetId: input.datasetId, sourceHash: input.sourceHash, dryRun: input.dryRun, items };
      if (!input.dryRun) {
        for (const grant of input.grants) if (items.find(item => item.user === grant.user)?.action === "created") this.save(grant);
        this.storage.sql.exec("INSERT INTO grant_imports(dataset,source_hash,receipt) VALUES (?,?,?)", input.datasetId, input.sourceHash, JSON.stringify(result));
      }
      return { replayed: false, ...result };
    });
  }
  private save(grant: Grant): void {
    this.storage.sql.exec(`INSERT INTO grants(user,value,revision) VALUES (?,?,1)
      ON CONFLICT(user) DO UPDATE SET value=excluded.value,revision=revision+1`, grant.user, JSON.stringify(grant));
  }
}

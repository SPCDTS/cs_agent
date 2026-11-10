import { DurableObject } from "cloudflare:workers";
import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { Env } from "../env";

const NameSchema = Type.String({ pattern: "^[a-zA-Z0-9:_-]{1,160}$" });
export const ResourceIdSchema = Type.String({ pattern: "^sbx:[a-f0-9-]{36,64}$" });
export const SandboxResourceSchema = Type.Object({
  id: ResourceIdSchema, owner: NameSchema, createdAt: Type.Number(), sourceId: Type.Optional(ResourceIdSchema),
  kind: Type.Literal("cloudflare"), providerId: Type.Literal("cloudflare"), name: NameSchema,
}, { additionalProperties: false });
export type SandboxResource = Static<typeof SandboxResourceSchema>;
export const CreateResourceSchema = Type.Object({
  providerId: Type.Optional(Type.Literal("cloudflare")), sourceId: Type.Optional(ResourceIdSchema),
}, { additionalProperties: false });
export const ResourceListSchema = Type.Object({ assignedSandboxId: ResourceIdSchema, resources: Type.Array(SandboxResourceSchema) });
type ResourceRecord = { kind: "ready"; resource: SandboxResource; fingerprint?: string }
  | { kind: "preparing"; resource: SandboxResource; fingerprint: string; sourceName?: string; clone?: { sourceName: string; sourceRevision: string; expectedRevision: string; operationId: string } };
const prefix = "resource:";
const key = (id: string) => prefix + id;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function isCloudflareRecord(record: { resource: unknown }): record is ResourceRecord {
  return Check(SandboxResourceSchema, record.resource);
}

/** 保留旧 owner 实例和键，仅解析 Cloudflare 资源。 */
export class CloudflareWorkspaceResourcesDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      // 改名后的实例可能仍持有旧设备连接及闹钟。
      await ctx.storage.deleteAlarm();
      for (const socket of ctx.getWebSockets()) socket.close(1001, "Transport retired");
    });
  }

  override async alarm(): Promise<void> {
    // 迁移前已经进入投递队列的闹钟直接结束。
  }

  async list(owner: string): Promise<Static<typeof ResourceListSchema>> {
    if (!Check(NameSchema, owner)) throw new Error("invalid_request");
    const id = "sbx:" + hash(owner + ":cloudflare");
    const resource: SandboxResource = { id, owner, kind: "cloudflare", providerId: "cloudflare", name: owner, createdAt: 0 };
    await this.ctx.storage.transaction(async tx => {
      if (!await tx.get(key(id))) await tx.put(key(id), { kind: "ready", resource } satisfies ResourceRecord);
    });
    const records = await this.ctx.storage.list<ResourceRecord>({ prefix });
    return { assignedSandboxId: id, resources: [...records.values()]
      .filter(record => isCloudflareRecord(record) && record.kind === "ready" && record.resource.owner === owner)
      .map(record => record.resource) };
  }

  async get(owner: string, id: string): Promise<SandboxResource | null> {
    if (!Check(ResourceIdSchema, id)) return null;
    const record = await this.ctx.storage.get<ResourceRecord>(key(id));
    return record && isCloudflareRecord(record) && record.resource.owner === owner && record.kind === "ready" ? record.resource : null;
  }

  async create(owner: string, operationId: string, input: unknown): Promise<SandboxResource> {
    if (!Check(NameSchema, owner) || !Check(NameSchema, operationId) || !Check(CreateResourceSchema, input)) throw new Error("invalid_request");
    const id = "sbx:" + hash(owner + ":create:" + operationId);
    const fingerprint = JSON.stringify({ providerId: "cloudflare", ...(input.sourceId ? { sourceId: input.sourceId } : {}) });
    let record = await this.ctx.storage.get<ResourceRecord>(key(id));
    if (!record) {
      const source = input.sourceId ? await this.get(owner, input.sourceId) : undefined;
      if (input.sourceId && !source) throw new Error("sandbox_not_found");
      const resource: SandboxResource = { id, owner, createdAt: Date.now(), kind: "cloudflare", providerId: "cloudflare",
        name: "resource:" + id.slice(4), ...(source ? { sourceId: source.id } : {}) };
      const candidate: ResourceRecord = { kind: "preparing", resource, fingerprint, ...(source ? { sourceName: source.name } : {}) };
      record = await this.ctx.storage.transaction(async tx => {
        const prior = await tx.get<ResourceRecord>(key(id));
        if (prior) return prior;
        const records = await tx.list<ResourceRecord>({ prefix });
        if ([...records.values()].filter(isCloudflareRecord).length >= 256) throw new Error("sandbox_limit");
        await tx.put(key(id), candidate);
        return candidate;
      });
    }
    // 旧登记按传入的键顺序序列化，保留两种合法顺序的重放。
    const legacyFingerprint = JSON.stringify({ sourceId: input.sourceId, providerId: "cloudflare" });
    if (!isCloudflareRecord(record) || record.resource.owner !== owner
      || (record.fingerprint !== fingerprint && record.fingerprint !== legacyFingerprint)) {
      throw new Error("operation_conflict");
    }
    if (record.kind === "preparing") {
      const provider = this.env.SANDBOX.getByName(record.resource.name);
      if (record.clone) {
        // 升级前的克隆记录已经固定版本，恢复时继续使用。
        const result = await provider.cloneFrom(record.clone);
        if (!result.ok) throw new Error("workspace_conflict");
      } else await provider.prepareResource({ operationId: "create:" + id, ...(record.sourceName ? { sourceName: record.sourceName } : {}) });
      await this.ctx.storage.put(key(id), { kind: "ready", resource: record.resource, fingerprint } satisfies ResourceRecord);
    }
    return record.resource;
  }
}

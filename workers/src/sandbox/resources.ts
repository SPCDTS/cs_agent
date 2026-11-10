import { Type, type Static } from "typebox";
import type { Env } from "../env";
import type { CatalogEntry } from "../remote-sandbox/wire";
import { IdSchema, ResourcePreparationSchema, parse } from "../../../runner/src/protocol";

export const ResourceIdSchema = Type.String({ pattern: "^sbx:[a-f0-9-]{36,64}$" });
export const ProviderIdSchema = Type.Union([Type.Literal("cloudflare"), Type.String({ pattern: "^remote:[a-f0-9-]{36}$" })]);
const common = { id: ResourceIdSchema, owner: IdSchema, createdAt: Type.Number(), sourceId: Type.Optional(ResourceIdSchema) };
export const SandboxResourceSchema = Type.Union([
  Type.Object({ ...common, kind: Type.Literal("cloudflare"), providerId: Type.Literal("cloudflare"), name: IdSchema }, { additionalProperties: false }),
  Type.Object({ ...common, kind: Type.Literal("remote"), providerId: Type.String({ pattern: "^remote:[a-f0-9-]{36}$" }), workspace: IdSchema,
    preparation: Type.Optional(ResourcePreparationSchema),
    // 只读兼容旧资源登记；不再下发旧来源初始化指令。
    sourceWorkspace: Type.Optional(IdSchema) }, { additionalProperties: false }),
]);
export type SandboxResource = Static<typeof SandboxResourceSchema>;
export const CreateResourceSchema = Type.Object({ providerId: ProviderIdSchema, sourceId: Type.Optional(ResourceIdSchema) }, { additionalProperties: false });
export const readResource = (json: string) => parse(SandboxResourceSchema, JSON.parse(json));
export const readResources = (json: string) => parse(Type.Array(SandboxResourceSchema), JSON.parse(json));
type Record = { kind: "ready"; resource: SandboxResource; fingerprint?: string }
  | { kind: "preparing"; resource: Extract<SandboxResource, { kind: "cloudflare" }>; fingerprint: string; sourceName?: string; clone?: { sourceName: string; sourceRevision: string; expectedRevision: string; operationId: string } };
const key = (id: string) => "resource:" + id;
async function digest(value: string) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, "0")).join(""); }

/** 资源 ID 独立于会话、子任务、租约与运行时实例；默认资源沿用已有物理工作区。 */
export class SandboxResources {
  constructor(private readonly storage: DurableObjectStorage, private readonly env: Env) {}
  async list(owner: string, catalog: CatalogEntry[]): Promise<SandboxResource[]> {
    parse(IdSchema, owner);
    for (const provider of catalog) {
      const id = "sbx:" + await digest(owner + ":" + provider.id);
      const resource: SandboxResource = provider.id === "cloudflare"
        ? { id, owner, kind: "cloudflare", providerId: "cloudflare", name: owner, createdAt: 0 }
        : { id, owner, kind: "remote", providerId: provider.id, workspace: this.env.SANDBOX.idFromName(owner).toString(), createdAt: 0 };
      await this.storage.transaction(async tx => { if (!await tx.get(key(id))) await tx.put(key(id), { kind: "ready", resource } satisfies Record); });
    }
    return [...(await this.storage.list<Record>({ prefix: "resource:" })).values()]
      .filter(record => record.kind === "ready" && record.resource.owner === owner).map(record => record.resource);
  }
  async get(owner: string, id: string): Promise<SandboxResource> {
    parse(ResourceIdSchema, id);
    const record = await this.storage.get<Record>(key(id));
    if (!record || record.resource.owner !== owner) throw new Error("sandbox_not_found");
    if (record.kind !== "ready") throw new Error("sandbox_preparing");
    return record.resource;
  }
  async create(owner: string, operationId: string, value: unknown, catalog: CatalogEntry[]): Promise<SandboxResource> {
    parse(IdSchema, owner); parse(IdSchema, operationId);
    const input = parse(CreateResourceSchema, value), id = "sbx:" + await digest(owner + ":create:" + operationId), fingerprint = JSON.stringify(input);
    let record = await this.storage.get<Record>(key(id));
    if (!record) {
      const provider = catalog.find(row => row.id === input.providerId);
      if (!provider) throw new Error("provider_not_found");
      if (!provider.resourceLifecycle) throw new Error("create_not_supported");
      const source = input.sourceId ? await this.get(owner, input.sourceId) : undefined;
      if (source && source.providerId !== provider.id) throw new Error("clone_provider_mismatch");
      if (source && !provider.resourceLifecycle.clone) throw new Error("clone_not_supported");
      const common = { id, owner, createdAt: Date.now(), ...(source ? { sourceId: source.id } : {}) };
      if (provider.id === "cloudflare") {
        const resource = { ...common, kind: "cloudflare", providerId: "cloudflare", name: "resource:" + id.slice(4) } satisfies SandboxResource;
        record = { kind: "preparing", resource, fingerprint, ...(source?.kind === "cloudflare" ? { sourceName: source.name } : {}) };
      } else {
        record = { kind: "ready", fingerprint, resource: { ...common, kind: "remote", providerId: provider.id, workspace: id,
          preparation: source?.kind === "remote" ? { kind: "clone", operationId: id, sourceWorkspace: source.workspace } : { kind: "create", operationId: id } } };
      }
      const candidate = record;
      record = await this.storage.transaction(async tx => {
        const prior = await tx.get<Record>(key(id)); if (prior) return prior;
        if ((await tx.list<Record>({ prefix: "resource:" })).size >= 256) throw new Error("sandbox_limit");
        await tx.put(key(id), candidate); return candidate;
      });
    }
    if (record.fingerprint !== fingerprint) throw new Error("operation_conflict");
    if (record.kind === "preparing") {
      const provider = this.env.SANDBOX.getByName(record.resource.name);
      if (record.clone) {
        // 恢复升级前已经开始的 Cloudflare 快照导入，沿用已固定的版本。
        const result = await provider.cloneFrom(record.clone); if (!result.ok) throw new Error("workspace_conflict");
      } else await provider.prepareResource({ operationId: "create:" + id, ...(record.sourceName ? { sourceName: record.sourceName } : {}) });
      await this.storage.put(key(id), { kind: "ready", resource: record.resource, fingerprint } satisfies Record);
    }
    return record.resource;
  }
}

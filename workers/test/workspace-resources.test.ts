import { createHash } from "node:crypto";
import { env, evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { SandboxDO } from "../src/sandbox/do";

afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const resources = () => env.CLOUDFLARE_WORKSPACE_RESOURCES.getByName("owner");
const resourceId = (seed: string) => "sbx:" + createHash("sha256").update(seed).digest("hex");
const legacyResource = (seed: string, name: string) => ({
  id: resourceId(seed), owner: "owner", kind: "cloudflare", providerId: "cloudflare", name, createdAt: 42,
});

it("保留旧 Cloudflare ID 和物理名称，旧远程记录不出现也不占创建配额", async () => {
  const existing = legacyResource("owner:create:legacy", "resource:old-physical");
  const oldRemote = Array.from({ length: 256 }, (_, index) => {
    const id = resourceId("old-remote:" + index);
    return { id, owner: "owner", kind: "remote", providerId: "remote:legacy", workspace: id };
  });
  await runInDurableObject(resources(), async (_instance, state) => {
    for (const resource of oldRemote) {
      await state.storage.put("resource:" + resource.id, { kind: "ready", resource });
    }
    await state.storage.put("resource:" + existing.id, { kind: "ready", resource: existing, fingerprint: '{"providerId":"cloudflare"}' });
    await state.storage.setAlarm(Date.now() + 60_000);
  });
  await evictDurableObject(resources());
  const list = await resources().list("owner");
  expect(await runInDurableObject(resources(), (_instance, state) => state.storage.getAlarm())).toBeNull();
  expect(list.assignedSandboxId).toBe(resourceId("owner:cloudflare"));
  expect(list.resources).toEqual(expect.arrayContaining([existing, expect.objectContaining({ id: list.assignedSandboxId, name: "owner" })]));
  expect(list.resources).toHaveLength(2);
  expect(await resources().get("owner", oldRemote[0]!.id)).toBeNull();
  expect(await resources().get("group:200000001", existing.id)).toBeNull();
  expect(await resources().create("owner", "legacy", {})).toEqual(existing);
  expect((await resources().create("owner", "new", {})).id).toBe(resourceId("owner:create:new"));
});

it("恢复旧 preparing 克隆时使用原先锁定的快照", async () => {
  const source = legacyResource("owner:cloudflare", "owner"), clone = legacyResource("owner:create:clone", "resource:old-clone");
  const snapshot = { sourceName: source.name, sourceRevision: "pinned", expectedRevision: "0", operationId: "original-op" };
  await runInDurableObject(resources(), async (_instance, state) => {
    await state.storage.put("resource:" + clone.id, { kind: "preparing", resource: { ...clone, sourceId: source.id },
      fingerprint: JSON.stringify({ sourceId: source.id, providerId: "cloudflare" }), clone: snapshot });
  });
  const cloneFrom = vi.spyOn(SandboxDO.prototype, "cloneFrom").mockImplementation(async function(this: SandboxDO) {
    return { ok: true, manifest: await this.files() };
  });
  expect(await resources().get("owner", clone.id)).toBeNull();
  expect(await resources().create("owner", "clone", { sourceId: source.id })).toMatchObject({ ...clone, sourceId: source.id });
  expect(await resources().get("owner", clone.id)).toMatchObject({ ...clone, sourceId: source.id });
  expect(cloneFrom).toHaveBeenCalledWith(snapshot);
  await expect((async () => resources().create("owner", "clone", {}))()).rejects.toThrow("operation_conflict");
});

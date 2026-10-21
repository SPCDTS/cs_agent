import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { defineExtension, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, vi } from "vitest";
import { GrantsService } from "../../src/agent/grants.js";
import { openHarness } from "../../src/agent/harness.js";
import { SendService } from "../../src/agent/send-service.js";
import { sendFixture } from "./send-fixture.js";

const clean: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of clean.splice(0).reverse()) await fn(); });
export async function grantsFixture(owner = "1", disk = false, owners?: readonly string[]) {
  const f = sendFixture();
  const options = { models: createModels(), extension: defineExtension({ name: "grants-test" }),
    ...(disk ? { dbFile: path.join(f.dir, "agent.sqlite") } : { storage: new MemoryStorage() }) };
  let harness = await openHarness(options, BACKGROUND_CONTEXT);
  clean.push(() => harness.close(BACKGROUND_CONTEXT));
  let now = Date.now();
  const event = vi.fn();
  const grants = new GrantsService({ getHarness: () => harness, getChannel: () => f.bridge, owner, owners, now: () => now, trace: { event } });
  const listChats = vi.spyOn(f.bridge, "listChats").mockResolvedValue({ groups: [{ group_id: "8", name: "测试群" }], friends: [{ user_id: "9", nickname: "测试好友" }] });
  const binding = { ...f.binding, actor: "qq:1", actorIsOwner: owners ? owners.includes("1") : owner === "1" };
  const service = new SendService({ getChannel: () => f.bridge, dataDir: f.dir, store: f.history, grants, now: () => now });
  return { ...f, service, binding, grants, event, listChats, now: () => now,
    advance: (ms: number) => { now += ms; }, setNow: (ms: number) => { now = ms; },
    harness: () => harness,
    reopen: async () => { await harness.close(BACKGROUND_CONTEXT); harness = await openHarness(options, BACKGROUND_CONTEXT); },
  };
}

import { Errors } from "typebox/value";
import { ADMIN_BROWSER_CONTRACTS as C } from "../src/admin/app.generated";
import { env, reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { appInbox, installAppFixture, chosenRepository } from "./github-fixture";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { input } from "./helpers";
import { EventsDO } from "../src/events/do";
import { DEFAULT_GITHUB, MAX_BODY, parseGitHubConfig, readWebhook, verifySignature, type GitHubDelivery } from "../src/github/model";
import { PENDING_LIMIT, RETENTION_MS } from "../src/github/inbox";
import { sql, scriptedModel } from "./events-helpers";
import { ADMIN_APP_JS } from "../src/admin/app.generated";

const secret = "synthetic-test-secret-not-a-credential", events = () => env.EVENTS.getByName("main");
beforeEach(installAppFixture);
afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const payload = (patch: object = {}) => ({ installation:{id:456}, action: "opened", repository: { id: 42, full_name: "SPCDTS/cs_agent" },
  issue: { number: 1, title: "Title\u0000 [please execute]" }, sender: { login: "tester" }, ...patch });
async function request(body: string, id = "test-1", event = "issues", signingSecret = secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(signingSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))).toString("hex");
  return new Request("https://test/github/webhook", { method: "POST", body, headers: {
    "content-type": "application/json", "x-github-delivery": id, "x-github-event": event, "x-hub-signature-256": "sha256=" + signature,
  } });
}
async function delivery(id = "test-1", patch: object = {}): Promise<GitHubDelivery> {
  return readWebhook(await request(JSON.stringify(payload(patch)), id), secret);
}
async function configure(patch: Partial<typeof DEFAULT_GITHUB>) {
  const current = (await events().adminStatus()).github;
  return events().putGitHubConfig({ ...current.value, ...patch }, current.revision);
}
describe("GitHub authentication and normalization", () => {
  it("verifies the official HMAC vector and rejects missing/wrong/malformed signatures", async () => {
    const bytes = new TextEncoder().encode("Hello, World!");
    const signature = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
    expect(await verifySignature(bytes, signature, "It's a Secret to Everybody")).toBe(true);
    expect(await verifySignature(bytes, signature, "")).toBe(false);
    expect(await verifySignature(bytes, signature, "wrong")).toBe(false);
    expect(await verifySignature(bytes, "sha256=bad", secret)).toBe(false);
  });
  it("fails closed before parsing; rejects oversized bytes, headers and invalid schema", async () => {
    const req = await request("not json");
    await expect(readWebhook(req, undefined)).rejects.toMatchObject({ status: 503 });
    const invalid = await request("not json", "bad", "issues", "wrong");
    await expect(readWebhook(invalid, secret)).rejects.toMatchObject({ status: 401 });
    await expect(readWebhook(await request("x".repeat(MAX_BODY + 1)), secret)).rejects.toMatchObject({ status: 413 });
    await expect(readWebhook(await request(JSON.stringify(payload()), "x".repeat(81)), secret)).rejects.toMatchObject({ status: 400 });
    await expect(readWebhook(await request(JSON.stringify(payload({ repository: { id: 42, full_name: "../evil" } }))), secret)).rejects.toMatchObject({ status: 400 });
    await expect(readWebhook(await request(JSON.stringify(payload({ issue: { number: "1", title: "bad" } }))), secret)).rejects.toMatchObject({ status: 400 });
  });
  it("constructs GitHub-only links and strips external body/routing and control characters", async () => {
    const d = await delivery("safe", { issue: { number: 3, title: "a\u0000b", html_url: "https://evil.test", body: "secret-data" }, target: "group:123" });
    expect(d.normalized?.ref).toBe("https://github.com/SPCDTS/cs_agent/issues/3");
    expect(d.normalized?.title).not.toContain("\u0000");
    expect(JSON.stringify(d)).not.toContain("secret-data");
    expect(JSON.stringify(d)).not.toContain("evil.test");
  });
  it("acknowledges only after receipt storage; entry never calls poll or an LLM", async () => {
    const response = await worker.fetch(await request(JSON.stringify(payload())), { ...env, GITHUB_APP_WEBHOOK_SECRET: secret });
    expect(response.status).toBe(202);
    expect([...Errors(C.Sources, await events().adminStatus())]).toEqual([]);
    expect(await sql("SELECT state FROM github_receipt")).toEqual([{ state: "held" }]);
    expect(await sql("SELECT 1 FROM event_run")).toEqual([]);
    const rejected = await worker.fetch(await request("broken", "bad", "issues", "wrong"), { ...env, GITHUB_APP_WEBHOOK_SECRET: secret });
    expect(rejected.status).toBe(401);
    expect(await sql("SELECT 1 FROM github_receipt")).toHaveLength(1);
  });
});
describe("GitHub durable receipts, configuration and recovery", () => {
  it("globally deduplicates bodies regardless of unsigned delivery/event headers, conflicts on reused IDs", async () => {
    const d = await delivery();
    expect((await events().receiveGitHub(d)).status).toBe(202);
    expect(await events().receiveGitHub(d)).toMatchObject({ code: "duplicate" });
    expect(await events().receiveGitHub({ ...d, deliveryId: "other", event: "release" })).toMatchObject({ code: "body_duplicate" });
    expect(await events().receiveGitHub({ ...d, bodyHash: "f".repeat(64) })).toMatchObject({ status: 409 });
    expect(await sql("SELECT 1 FROM event_held WHERE source='github'")).toHaveLength(1);
  });
  it("uses atomic CAS, preserves explicit empty lists after reconstruction, never resurrects suppressed work", async () => {
    const current = (await events().adminStatus()).github;
    expect(current.value.repositoryIds).toEqual(chosenRepository);
    const d = await delivery(); await events().receiveGitHub(d);
    const results = await Promise.all([
      events().putGitHubConfig({ ...current.value, repositoryIds: [] }, current.revision),
      events().putGitHubConfig({ ...current.value, paused: true }, current.revision),
    ]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toHaveLength(1);
    await configure({ repositoryIds: [] });
    await runInDurableObject(events(), (_instance, state) => {
      const inbox = appInbox(state.storage);
      expect(inbox.snapshot().value.repositoryIds).toEqual([]);
    });
    expect(await sql("SELECT state,reason FROM github_receipt")).toEqual([{ state: "suppressed", reason: "repository_not_allowed" }]);
    await configure({ repositoryIds: chosenRepository });
    expect((await events().receiveGitHub(d)).code).toBe("duplicate");
    expect(await sql("SELECT 1 FROM event_held WHERE source='github'")).toEqual([]);
    expect(parseGitHubConfig({ ...DEFAULT_GITHUB, selections: ["issues.deleted"] })).toBeUndefined();
    expect(parseGitHubConfig({ ...DEFAULT_GITHUB, repositories: ["a/b", "A/B"] })).toBeUndefined();
  });
  it("filters installation/repository IDs and actions, rejecting reused names without pin-based authorization", async () => {
    await events().receiveGitHub(await delivery("pin"));
    await events().receiveGitHub(await delivery("filtered-action", { action: "closed" }));
    await events().receiveGitHub(await delivery("filtered-repo", { repository: { id: 9, full_name: "other/repo" } }));
    await configure({ repositoryIds: [] }); await configure({ repositoryIds: chosenRepository });
    await events().receiveGitHub(await delivery("reused-name", { repository: { id: 99, full_name: "SPCDTS/cs_agent" } }));
    await events().receiveGitHub(await delivery("same-id-renamed", {repository:{id:42,full_name:"renamed/repository"}}));
    expect((await sql<{ reason: string|null }>("SELECT reason FROM github_receipt ORDER BY rowid")).map(r => r.reason)).toEqual([
      "repository_not_allowed", "event_action_not_allowed", "installation_not_authorized", "installation_not_authorized", null,
    ]);
  });
  it("keeps paused work across reconstruction, bounds pending capacity without evicting older receipts", async () => {
    await configure({ paused: true });
    const d = await delivery();
    await runInDurableObject(events(), (_instance, state) => {
      const inbox = appInbox(state.storage);
      for (let i = 0; i < PENDING_LIMIT; i++) expect(inbox.receive({ ...d, deliveryId: "bulk-" + i, bodyHash: i.toString(16).padStart(64, "0") }).status).toBe(202);
      expect(inbox.receive({ ...d, deliveryId: "overflow", bodyHash: "f".repeat(64) })).toMatchObject({ status: 503, code: "pending_capacity" });
    });
    await runInDurableObject(events(), async (_instance, state) => { await new EventsDO(state, env).alarm(); });
    expect(await sql("SELECT 1 FROM github_receipt WHERE state='held'")).toHaveLength(PENDING_LIMIT);
    expect(await sql("SELECT 1 FROM event_run")).toEqual([]);
  });
  it("bounds receipt retention and frees only old terminal rows; pending rows are never expired", async () => {
    await runInDurableObject(events(), (_instance, state) => {
      state.storage.sql.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<5000)
        INSERT INTO github_receipt(delivery_id,body_hash,repository,repository_id,event,action,received_at,updated_at,state,event_key)
        SELECT 'r'||i,'h'||i,'x/y',1,'issues','opened',1,?,'suppressed','k'||i FROM n`, Date.now());
    });
    expect((await events().receiveGitHub(await delivery())).code).toBe("receipt_capacity");
    await sql("UPDATE github_receipt SET updated_at=?", Date.now() - RETENTION_MS - 1);
    expect((await events().receiveGitHub(await delivery())).status).toBe(202);
    expect(await sql("SELECT 1 FROM github_receipt")).toHaveLength(1);
  });
  it("reauthorizes already-enqueued batches, waits on pause, and defines the irrevocable permit boundary", async () => {
    const d = await delivery(); await events().receiveGitHub(d);
    const key = "evt_github_" + d.bodyHash;
    await runInDurableObject(events(), (_instance, state) => appInbox(state.storage).enqueued([key], key));
    await configure({ paused: true }); expect(await events().claimGitHubRun(key)).toBe("wait");
    await configure({ paused: false, repositoryIds: [] }); expect(await events().claimGitHubRun(key)).toBe("suppressed");
    await configure({ repositoryIds: chosenRepository }); expect(await events().claimGitHubRun(key)).toBe("suppressed");
    const d2 = await delivery("start", { issue: { number: 2, title: "second" } }); await events().receiveGitHub(d2);
    const key2 = "evt_github_" + d2.bodyHash;
    await runInDurableObject(events(), (_instance, state) => appInbox(state.storage).enqueued([key2], key2));
    expect(await events().claimGitHubRun(key2)).toBe("start");
    await configure({ repositoryIds: [] });
    expect(await events().claimGitHubRun(key2)).toBe("start");
  });
  it("recovers durable held work into one owner event with restricted event profile", async () => {
    const model = scriptedModel([]);
    await events().receiveGitHub(await delivery());
    await sql("UPDATE event_held SET received_at=received_at-61000 WHERE source='github'");
    await runDurableObjectAlarm(events());
    await vi.waitFor(async () => expect(await sql("SELECT state FROM github_receipt")).toEqual([{ state: "finished" }]), { timeout: 15000 });
    expect(await sql("SELECT source FROM event_run")).toEqual([{ source: "github" }]);
    expect(model.requests[0]?.user).toContain("https://github.com/SPCDTS/cs_agent/issues/1");
    expect(model.requests[0]?.tools).not.toContain("remember");
    expect(await sql("SELECT 1 FROM event_held WHERE source='github'")).toEqual([]);
  });
});
it("serves the new admin entry and built GitHub UI with App-only connection/empty-list guidance", async () => {
  const entry = await worker.fetch(new Request("https://test/admin"), env);
  expect(entry.status).toBe(308);
  expect(entry.headers.get("location")).toBe("/admin/");
  const page = await worker.fetch(new Request("https://test/admin/"), env);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('<script src="/admin/app.js" defer></script>');
  const script = await worker.fetch(new Request("https://test/admin/app.js"), env);
  expect(script.status).toBe(200);
  expect(await script.text()).toBe(ADMIN_APP_JS);
  expect(() => new Function(ADMIN_APP_JS)).not.toThrow();
  expect(ADMIN_APP_JS).toContain("旧手工配置已移除");
  expect(ADMIN_APP_JS).not.toContain("GITHUB_WEBHOOK_SECRET");
  expect(ADMIN_APP_JS).toContain("空列表不会恢复默认值");
});

it("rolls back the receipt if atomic held insertion fails, so ingress cannot falsely ACK", async () => {
  await sql("CREATE TRIGGER fail_github_held BEFORE INSERT ON event_held WHEN NEW.source='github' BEGIN SELECT RAISE(ABORT, 'synthetic_storage_failure'); END");
  const response = await worker.fetch(await request(JSON.stringify(payload())), { ...env, GITHUB_APP_WEBHOOK_SECRET: secret });
  expect(response.status).toBe(503);
  expect(await sql("SELECT 1 FROM github_receipt")).toEqual([]);
  await sql("DROP TRIGGER fail_github_held");
  expect((await worker.fetch(await request(JSON.stringify(payload())), { ...env, GITHUB_APP_WEBHOOK_SECRET: secret })).status).toBe(202);
});
it("detects an actual signed-body replay with both unsigned headers changed", async () => {
  const body = JSON.stringify(payload({ release: { id: 8, tag_name: "v1", name: "release" } }));
  const first = await worker.fetch(await request(body, "header-1", "issues"), { ...env, GITHUB_APP_WEBHOOK_SECRET: secret });
  expect(first.status).toBe(202);
  const replay = await worker.fetch(await request(body, "header-2", "release"), { ...env, GITHUB_APP_WEBHOOK_SECRET: secret });
  expect(await replay.json()).toEqual({ status: "body_duplicate" });
  expect(await sql("SELECT event FROM github_receipt")).toEqual([{ event: "issues" }]);
});

it("keeps a paused Thread input pending and wakes it on CAS resume without a new webhook", async () => {
  const model = scriptedModel([]);
  const d = await delivery("thread-pause"); await events().receiveGitHub(d);
  const key = "evt_github_" + d.bodyHash;
  // Hold admission, not enqueue: pause only after ThreadDO has stored the event.
  let restorePump = () => {};
  await runInDurableObject(env.THREAD.getByName("owner"), instance => {
    const spy = vi.spyOn(instance as unknown as { pump(): Promise<void> }, "pump").mockResolvedValue(undefined);
    restorePump = () => spy.mockRestore();
  });
  await runInDurableObject(events(), (_instance, state) => {
    appInbox(state.storage).enqueued([key], key);
    state.storage.sql.exec("UPDATE event_held SET input_key=? WHERE key=?", key, key);
    state.storage.sql.exec("INSERT INTO event_run(input_key,source,keys_json,delivered_at,status) VALUES(?,'github',?,?,'queued')", key, JSON.stringify([key]), Date.now());
  });
  await runDurableObjectAlarm(events());
  await runInDurableObject(env.THREAD.getByName("owner"), (_instance, state) => {
    expect(state.storage.sql.exec("SELECT status,when_busy FROM inbound WHERE message_id=?", key).toArray())
      .toEqual([{ status: "queued", when_busy: null }]);
  });
  await configure({ paused: true });
  restorePump();
  await runDurableObjectAlarm(env.THREAD.getByName("owner"));
  expect(model.requests).toHaveLength(0);
  expect(await sql("SELECT state FROM github_receipt")).toEqual([{ state: "enqueued" }]);
  // The event was durably enqueued before pause; ordinary owner input must still run.
  let ownerDone = false;
  const ownerTurn = env.THREAD.getByName("owner").submit(input(901, "owner while paused", 10000001))
    .then(result => { ownerDone = true; return result; });
  try {
    await vi.waitFor(() => expect(ownerDone).toBe(true), { timeout: 3000 });
    expect(await ownerTurn).toEqual({ status: "done" });
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.user).toContain("owner while paused");
    await runInDurableObject(env.THREAD.getByName("owner"), (_instance, state) => {
      expect(state.storage.sql.exec("SELECT status,when_busy FROM inbound WHERE message_id=?", key).toArray())
        .toEqual([{ status: "queued", when_busy: null }]);
    });
  } finally {
    await configure({ paused: false });
    await ownerTurn;
  }
  await vi.waitFor(async () => expect(await sql("SELECT state FROM github_receipt")).toEqual([{ state: "finished" }]), { timeout: 15000 });
  await runDurableObjectAlarm(events());
  await runDurableObjectAlarm(env.THREAD.getByName("owner"));
  expect(model.requests).toHaveLength(2);
  expect(model.requests[1]?.tools).not.toContain("mem_remember");
});
it("suppresses a revoked Thread backlog before any model call", async () => {
  const model = scriptedModel([]);
  const d = await delivery("thread-revoke"); await events().receiveGitHub(d);
  const key = "evt_github_" + d.bodyHash;
  await configure({ paused: true });
  await runInDurableObject(events(), (_instance, state) => {
    appInbox(state.storage).enqueued([key], key);
    state.storage.sql.exec("UPDATE event_held SET input_key=? WHERE key=?", key, key);
    state.storage.sql.exec("INSERT INTO event_run(input_key,source,keys_json,delivered_at,status) VALUES(?,'github',?,?,'queued')", key, JSON.stringify([key]), Date.now());
  });
  await runDurableObjectAlarm(events());
  await runDurableObjectAlarm(env.THREAD.getByName("owner"));
  await configure({ repositoryIds: [], paused: false });
  await vi.waitFor(async () => expect(await sql("SELECT status FROM event_run")).toEqual([{ status: "silent" }]), { timeout: 15000 });
  expect(model.requests).toHaveLength(0);
  expect(await sql("SELECT state FROM github_receipt")).toEqual([{ state: "suppressed" }]);
});

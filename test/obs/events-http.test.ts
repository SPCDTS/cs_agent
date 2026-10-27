import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import { ContextStore } from "../../src/context/store.js";
import { ObsStore } from "../../src/obs/store.js";
import { createDashboard } from "../../src/obs/http.js";
import { eventRig } from "../agent/events/fixture.js";

const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });
it("事件面板列表、表单与 JSON 操作经过 cookie、同源及 CSRF 校验", async () => {
  const poll = vi.fn(async () => ({ cursor: "1", events: [] }));
  const events = await eventRig({ id: "gmail", poll }); clean.push(() => events.close());
  const dir = mkdtempSync(path.join(os.tmpdir(), "cs-events-http-")), token = "events-test-token";
  const store = new ObsStore(dir), context = new ContextStore(dir);
  const dashboard = createDashboard({ config: loadConfig({ DATA_DIR: dir, OBS_TOKEN: token, QQ_OWNER: "1" }), store, context,
    health: () => ({}), queue: () => ({}), codex: async () => ({}), pi: async () => ({}), events: events.service });
  const server = createServer(dashboard.handle);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("address");
  const base = `http://127.0.0.1:${address.port}`, Cookie = `obs_token=${token}`;
  clean.push(async () => {
    await dashboard.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    store.close(); context.close(); rmSync(dir, { recursive: true, force: true });
  });
  expect((await fetch(base + "/api/events")).status).toBe(401);
  const list = await (await fetch(base + "/api/events", { headers: { Cookie } })).json();
  expect(list).toMatchObject({ sources: [expect.objectContaining({ id: "gmail", enabled: true })], runs: [], csrf: expect.any(String) });
  const post = (action: string, headers: Record<string, string> = {}) => fetch(base + "/api/events/gmail/" + action, {
    method: "POST", headers: { Cookie, Origin: base, "Content-Type": "application/json", "X-CSRF-Token": list.csrf, ...headers }, body: "{}",
  });
  for (const action of ["pause", "resume", "poll"]) {
    expect((await post(action, { "X-CSRF-Token": "" })).status).toBe(403);
    expect((await post(action, { Origin: "https://attacker.example" })).status).toBe(403);
    expect((await post(action, { Cookie: "" })).status).toBe(401);
  }
  expect(poll).not.toHaveBeenCalled();
  expect((await post("pause")).status).toBe(200); expect((await events.state()).enabled).toBe(false);
  expect((await post("resume")).status).toBe(200); expect((await events.state()).enabled).toBe(true);
  expect((await post("poll")).status).toBe(200); expect(poll).toHaveBeenCalledTimes(1);
  const html = await (await fetch(base + "/events", { headers: { Cookie } })).text();
  expect(html).toContain('name="_csrf"'); expect(html).toContain("立即轮询"); expect(html).toContain("gmail");
  const form = await fetch(base + "/events/gmail/pause", { method: "POST", redirect: "manual", headers: {
    Cookie, Origin: base, "Content-Type": "application/x-www-form-urlencoded",
  }, body: new URLSearchParams({ _csrf: list.csrf }) });
  expect(form.status).toBe(303); expect((await events.state()).enabled).toBe(false);
});

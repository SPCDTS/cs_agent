import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { createDashboard } from "../../src/obs/http.js";
import { csrfToken } from "../../src/obs/http-util.js";
import { ObsStore } from "../../src/obs/store.js";
import { grantsFixture } from "../agent/grants-fixture.js";

const clean: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const fn of clean.splice(0).reverse()) await fn(); });
async function setup(owner = true) {
  const f = await grantsFixture();
  const token = "grants-dashboard-test-token", store = new ObsStore(f.dir);
  const config = loadConfig({ DATA_DIR: f.dir, OBS_TOKEN: token, QQ_ALLOW_USERS: owner ? "1" : "*", QQ_OWNER: "" });
  const dashboard = createDashboard({ grants: f.grants, config, store, context: f.history,
    health: () => ({}), queue: () => ({}), codex: async () => [], pi: async () => ({}) });
  const server = createServer(dashboard.handle);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  clean.push(async () => { await dashboard.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`, cookie = `obs_token=${token}`;
  const post = (action: string, fields: Record<string, string>, headers: Record<string, string> = {}) => fetch(`${base}/settings/grants/${action}`, {
    method: "POST", redirect: "manual", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields),
  });
  return { ...f, post, base, csrf: csrfToken(token), page: () => fetch(base + "/settings", { headers: { Cookie: cookie } }) };
}

it("设置页列出授权、添加和撤销，过期状态与 panel 前后差异可见", async () => {
  const f = await setup();
  expect(await (await f.page()).text()).toContain('action="/settings/grants/add"');
  const result = await f.post("add", { _csrf: f.csrf, user: "qq:9", caps: "send", targets: "qq:group:8\nqq:private:9", scopes: "group:7", expires_in_hours: "1" });
  expect(result.status).toBe(303);
  expect(await f.grants.list()).toEqual([expect.objectContaining({ targets: ["qq:group:8", "qq:private:9"], scopes: ["group:7"], granted_by: "qq:1" })]);
  f.advance(3_600_000);
  expect(await (await f.page()).text()).toContain("已过期");
  expect((await f.post("revoke", { _csrf: f.csrf, user: "qq:9" })).status).toBe(303);
  expect(await f.grants.list()).toEqual([]);
  expect(f.event.mock.calls.map(c => c[2].detail.source)).toEqual(["panel", "panel"]);
});

it("增删均执行登录、同源和 CSRF 校验，非法输入不落盘", async () => {
  const f = await setup();
  for (const action of ["add", "revoke"]) {
    const fields = { user: "qq:9", caps: "send" };
    expect((await f.post(action, fields)).status).toBe(403);
    expect((await f.post(action, { ...fields, _csrf: f.csrf }, { Origin: "https://evil.test" })).status).toBe(403);
    expect((await f.post(action, { ...fields, _csrf: f.csrf }, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await f.post(action, { ...fields, _csrf: f.csrf }, { Cookie: "" })).status).not.toBe(303);
  }
  expect((await f.post("add", { _csrf: f.csrf, user: "qq:9", caps: "admin" })).status).toBe(400);
  expect(await f.grants.list()).toEqual([]);
});

it("没有配置 owner 时授权只读，持有面板令牌也不能修改", async () => {
  const f = await setup(false);
  expect(await (await f.page()).text()).not.toContain('action="/settings/grants/add"');
  expect((await f.post("add", { _csrf: f.csrf, user: "qq:9", caps: "send" })).status).toBe(403);
  expect(await f.grants.list()).toEqual([]);
});

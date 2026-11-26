import assert from "node:assert/strict";
import { test } from "node:test";
import { ADMIN_PAGE_HTML } from "../src/admin/app.generated.ts";
import { bundleModule, mountDom } from "./browser-harness.mjs";

test("管理台 Skill 群授权与状态支持渲染、授权保存、撤销与二次确认清空状态", async t => {
  const page = mountDom(ADMIN_PAGE_HTML, { token: "synthetic-admin" });
  const ui = await bundleModule("browser/skill-runtime.ts");
  const state = {
    skills: [
      {
        skill: "shop",
        description: "商城查询技能",
        enabled: true,
        updatedAt: 1790000000000,
        authExitCode: 41,
        deps: "npm",
        actions: [
          { name: "login", description: "主人登录", ownerOnly: true, timeoutSec: 90 },
          { name: "query", description: "查询商品", ownerOnly: false, timeoutSec: 30 },
          { name: "detail", description: "商品详情", ownerOnly: false, timeoutSec: 30 },
        ],
        grants: [],
        state: {
          skill: "shop",
          revision: "rev-1",
          updatedAt: 1790000000000,
          totalBytes: 128,
          fileCount: 1,
          files: [{ path: "session.json", bytes: 128, mode: 384 }],
        },
      },
    ],
    groups: [{ key: "group:200000001", name: "测试群" }],
  };

  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const method = init.method ?? "GET";
    if (url === "/admin/skill-runtime" && method === "GET") {
      return Response.json(state);
    }
    if (url === "/admin/skill-runtime/shop/grants" && method === "PUT") {
      const body = JSON.parse(init.body);
      state.skills[0].grants = body.actions.length
        ? [{ group: body.group, actions: body.actions, revision: "g-1", updatedAt: 1790000001000 }]
        : [];
      return Response.json({ skill: "shop", group: body.group, actions: body.actions, revision: body.actions.length ? "g-1" : "" });
    }
    if (url === "/admin/skill-runtime/shop/state/clear" && method === "POST") {
      state.skills[0].state = { skill: "shop", revision: "0", updatedAt: 0, totalBytes: 0, fileCount: 0, files: [] };
      return Response.json({ skill: "shop", cleared: true });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });

  ui.initSkillRuntime();
  await ui.loadSkillRuntime();
  const root = page.document.getElementById("skill-runtime-list");
  assert.match(root.textContent, /shop/);
  assert.match(root.textContent, /仅主人/);
  assert.match(root.textContent, /session\.json/);

  const checkboxes = [...root.querySelectorAll('input[type="checkbox"]')];
  assert.deepEqual(checkboxes.map(c => c.value), ["query", "detail"]);
  checkboxes[0].checked = true;
  const form = root.querySelector("form");
  form.dispatchEvent(new page.window.Event("submit", { cancelable: true }));
  await page.settle();
  assert.match(root.textContent, /测试群 \(group:200000001\)/);
  assert.match(root.textContent, /动作：query/);

  const revokeBtn = [...root.querySelectorAll("button")].find(b => b.textContent === "撤销");
  assert.ok(revokeBtn);
  await page.click(revokeBtn);
  assert.match(root.textContent, /尚未授权任何群/);

  const clearBtn = [...root.querySelectorAll("button")].find(b => b.textContent === "清空登录态");
  assert.ok(clearBtn);
  await page.click(clearBtn);
  assert.equal(clearBtn.textContent, "确认清空登录态？");
  await page.click(clearBtn);
  assert.match(root.textContent, /尚无已保存的登录态文件/);
});

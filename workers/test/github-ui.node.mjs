import { test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_PAGE_HTML } from "../src/admin/app.generated.ts";
import { bundleModule, mountDom } from "./browser-harness.mjs";

const { document, click } = mountDom(ADMIN_PAGE_HTML, { token: "synthetic-admin-test" });
const consoleMock = 'export const cs = {}, consoleView = () => {}, renderConsoleThreads = () => {}, resetConsole = () => {}, startConsole = () => {}; export const chooseSubagent = () => { throw new Error("unexpected_console_navigation"); };';

// PR checks build the merge tree: main may import a newer console API than this branch does.
// Exercise that interface explicitly as well, so an outdated fixture fails on the branch too.
for (const integratedConsole of [false, true]) {
  test("new admin loadSources reaches typed GitHub config and receipts, paginates 10/1/back and preserves edits" +
    (integratedConsole ? " with integrated console navigation" : ""), async () => {
    const { loadSources, renderSources, state } = await bundleModule({
      contents: 'export { loadSources, renderSources, state } from "./browser/app.ts";' +
        (integratedConsole ? ' export { chooseSubagent } from "./browser/console";' : ""),
    }, {
      "./console": consoleMock,
      "./browser/console": consoleMock,
      "./management": "export const loadManagement = () => {}, selectManagementSubtab = () => {};",
      "./memory": "export const loadMemory = () => {}, memoryDetail = () => {}, mm = {};",
    });

    const sources = document.getElementById("sources");
    sources.replaceChildren();
    state.editingSource = null;
    state.sourceForms = {};

    const github = {
      connections: {
        configured: true, slug: "test-app", identities: [],
        installations: [{ installationId: 456, user: { id: 7, login: "owner" }, repositories: [{ id: 42, name: "SPCDTS/cs_agent" }], status: "active", until: Date.now() + 600000 }],
      },
      configured: true, count: 11, capacity: 100, pendingCapacity: 100, revision: "1",
      value: { repositoryIds: [{ installationId: 456, repositoryId: 42 }], paused: false, selections: [], settings: { intervalS: 60, mergeWindowS: 0, budgetPerHour: 10, filters: { requireLabels: [], excludeLabels: [], excludeSenders: [] } } },
      receipts: Array.from({ length: 11 }, (_, i) => ({ delivery_id: "d" + i, received_at: i, repository: "a/b", event: "issues", action: "opened", state: "held", reason: null, outcome: null })),
    };
    const view = {
      sources: [{ id: "github", paused: false, degraded: false, cursor: null, lastPollAt: null, held: 11, budget: { used: 0, perHour: 10 }, failures: 0, configured: true, settings: github.value.settings }],
      github, watch: { topic: false, expiration: null }, runs: [],
    };
    globalThis.fetch = async (path, options) => {
      assert.equal(path, "/admin/event-sources"); assert.equal(options.method, "GET");
      return new Response(JSON.stringify(view));
    };

    await loadSources();
    const render = () => { renderSources(view); return sources.children[0]; };
    let card = sources.children[0];
    assert.equal(card.querySelector("strong").textContent, "GitHub App");
    const body = () => card.querySelector("tbody");
    const pager = () => [...card.children].find(n => n.dataset.listPager === "true");
    const buttons = () => [...pager().querySelectorAll("button")];
    assert.equal(body().children.length, 10);
    assert.equal(body().firstElementChild.lastElementChild.textContent, "尚未结算");
    await click(buttons()[1], 2);
    assert.equal(body().children.length, 1);
    assert.equal(body().children[0].children[1].textContent, "d10");

    const form = state.sourceForms.github;
    assert.equal(form.querySelector("input").checked, true);
    state.editingSource = "github"; form.open = true; form.querySelector("input").checked = false;
    card = render();
    assert.equal(body().children.length, 1);
    assert.equal(state.sourceForms.github, form);
    assert.equal(form.querySelector("input").checked, false);

    await click(buttons()[0], 2);
    assert.equal(body().children.length, 10);
    assert.equal(body().children[0].children[1].textContent, "d0");

    github.receipts = [{ ...github.receipts[0], state: "finished", outcome: "silent" }];
    card = render();
    assert.equal(body().children.length, 1);
    assert.equal(body().firstElementChild.lastElementChild.textContent, "silent");
    assert.equal(pager().hidden, true);
  });
}

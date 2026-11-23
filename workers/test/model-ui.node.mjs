import { test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_PAGE_HTML } from "../src/admin/app.generated.ts";
import { bundleModule, mountDom } from "./browser-harness.mjs";

const { document, settle } = mountDom(ADMIN_PAGE_HTML, { token: "synthetic-admin-test" });
const consoleMock = 'export const cs = {}, consoleView = () => {}, renderConsoleThreads = () => {}, resetConsole = () => {}, startConsole = () => {}, chooseSubagent = () => {};';

test("管理台模型卡片支持选择与一键清除子任务默认模型，并在子任务表格展示模型列", async () => {
  const puts = [];
  let currentSubagent = { provider: "openai-codex", id: "gpt-6-astra", reasoningEffort: "high" };

  globalThis.__modelReadApi = async (_schema, method, path, body) => {
    if (method === "PUT" && path === "/admin/model") {
      puts.push(body);
      currentSubagent = body.subagentModel ?? undefined;
      return {
        revision: "0123456789abcdef",
        current: body.model,
        ...(currentSubagent ? { subagent: currentSubagent } : {}),
        providers: [
          { id: "deepseek", name: "DeepSeek", available: true, models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }, { id: "deepseek-reasoner", name: "DeepSeek Reasoner" }] },
          { id: "openai-codex", name: "ChatGPT 订阅", available: false, reason: "reauth_required", models: [] },
        ],
        codex: { status: "reauth_required", loggedIn: false, needsReauth: true, hasCredential: true, accounts: [] },
      };
    }
    if (path === "/admin/settings") {
      return {
        revision: "0123456789abcdef",
        value: { groupTrigger: "mention_or_reply", allowGroups: [], allowUsers: [], extractNamespaces: [], model: { provider: "deepseek", id: "deepseek-chat" } },
        defaults: { groupTrigger: "mention_or_reply", allowGroups: [], allowUsers: [], extractNamespaces: [], model: { provider: "deepseek", id: "deepseek-chat" } },
        overrides: null,
      };
    }
    throw new Error("unexpected api call: " + method + " " + path);
  };

  const { renderModel, saveModel, resetSubagentModel, renderSubagents } = await bundleModule({
    contents: 'export { renderModel, saveModel, resetSubagentModel, renderSubagents } from "./browser/app.ts";',
  }, {
    "./api": 'export class ApiError extends Error {} export const readApi = (...args) => globalThis.__modelReadApi(...args), api = (...args) => globalThis.__modelReadApi(null, ...args), readToken = () => "t", writeToken = () => {};',
    "./console": consoleMock,
    "./management": "export const loadManagement = () => {};",
    "./memory": "export const loadMemory = () => {}, memoryDetail = () => {}, mm = {};",
  });

  // 初始状态：主模型为 deepseek-chat，子任务默认为不可用的 openai-codex/gpt-6-astra
  renderModel({
    revision: "fedcba9876543210",
    current: { provider: "deepseek", id: "deepseek-chat" },
    subagent: currentSubagent,
    providers: [
      { id: "deepseek", name: "DeepSeek", available: true, models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }, { id: "deepseek-reasoner", name: "DeepSeek Reasoner" }] },
      { id: "openai-codex", name: "ChatGPT 订阅", available: false, reason: "reauth_required", models: [] },
    ],
    codex: { status: "reauth_required", loggedIn: false, needsReauth: true, hasCredential: true, accounts: [] },
  });

  assert.match(document.getElementById("m-current").textContent, /子任务默认：openai-codex\/gpt-6-astra · high/);
  assert.equal(document.getElementById("m-sub-model").value, "openai-codex/gpt-6-astra");
  assert.equal(document.getElementById("m-sub-effort").value, "high");
  assert.equal(document.getElementById("m-sub-reset").hidden, false);

  // 点击「恢复跟随主模型」：即使 Codex 不可用也能直接发送 subagentModel: null 解除绑定
  await resetSubagentModel();
  await settle();
  assert.deepEqual(puts[0], {
    model: { provider: "deepseek", id: "deepseek-chat" },
    subagentModel: null,
    expectedRevision: "fedcba9876543210",
  });
  assert.equal(document.getElementById("m-sub-model").value, "");
  assert.equal(document.getElementById("m-sub-reset").hidden, true);
  assert.match(document.getElementById("m-current").textContent, /子任务跟随主模型/);

  // 手动选择子任务默认模型并保存
  document.getElementById("m-sub-model").value = "deepseek/deepseek-reasoner";
  document.getElementById("m-sub-effort").value = "medium";
  await saveModel();
  await settle();
  assert.deepEqual(puts[1], {
    model: { provider: "deepseek", id: "deepseek-chat" },
    subagentModel: { provider: "deepseek", id: "deepseek-reasoner", reasoningEffort: "medium" },
    expectedRevision: "0123456789abcdef",
  });

  // 子任务表格展示模型列
  const box = renderSubagents("owner", [{
    id: "11111111-2222-3333-4444-555555555555",
    task: "检查日志",
    summary: "检查日志",
    status: "done",
    model: { provider: "deepseek", id: "deepseek-reasoner", reasoningEffort: "medium" },
    createdAt: 1700000000000,
    endedAt: 1700000005000,
    lastActiveAt: 1700000005000,
    spawner: "owner 10000001",
  }]);
  assert.match(box.textContent, /deepseek\/deepseek-reasoner · medium/);
});

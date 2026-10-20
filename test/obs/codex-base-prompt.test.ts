import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexBasePromptStore, MANAGED_QQ_INSTRUCTIONS } from "../../src/agent/codex/base-prompt.js";
import { SettingsStore, settingsDefaults, SETTINGS_TICKET } from "../../src/agent/settings.js";
import { createDashboard } from "../../src/obs/http.js";
import { csrfToken } from "../../src/obs/http-util.js";
import { ObsStore } from "../../src/obs/store.js";
import { ContextStore } from "../../src/context/store.js";
import { loadConfig } from "../../src/config.js";
import { trace } from "../../src/shared/trace.js";
import { redactText, registerSecrets } from "../../src/shared/redact.js";
import { tmp } from "../agent/helpers.js";

const TOKEN = "base-prompt-dashboard-token", MODEL = "codex/gpt-6.1-sol", OTHER = "codex/gpt-6-astra";
const clean: (() => Promise<void>)[] = [];
afterEach(async () => { trace.attach(undefined); for (const fn of clean.splice(0).reverse()) await fn(); });

async function rig(template: string | null = "目录默认\n") {
  const dir = tmp("cs-base-dashboard-"), codexHome = path.join(dir, "codex");
  await fs.mkdir(codexHome);
  const config = loadConfig({ DATA_DIR: dir, OBS_TOKEN: TOKEN, QQ_ALLOW_USERS: "1", CODEX_MODEL: MODEL });
  registerSecrets([TOKEN]);
  const store = new ObsStore(dir), context = new ContextStore(dir);
  trace.attach(store);
  const settings = await SettingsStore.open(dir, settingsDefaults({ ...config, backendOverrides: {} }));
  if (template !== null) await fs.writeFile(path.join(codexHome, "models_cache.json"), JSON.stringify({ models: [
    { slug: MODEL, model_messages: { instructions_template: template } },
    { slug: OTHER, model_messages: { instructions_template: "其它模型默认" } },
  ] }), "utf8");
  const prompts = new CodexBasePromptStore({ dataDir: dir, codexHome, containsSecret: s => redactText(s, 1_000_000) !== s });
  const dashboard = createDashboard({ config, store, context, settings, codexBasePrompt: prompts,
    health: () => ({}), queue: () => ({}), codex: async () => ({}), pi: async () => ({}) });
  const server = createServer(dashboard.handle);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  clean.push(async () => {
    await dashboard.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close(); context.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const cookie = `obs_token=${encodeURIComponent(TOKEN)}`;
  const get = async () => (await fetch(base + "/settings", { headers: { Cookie: cookie } })).text();
  const form = async () => ({ _csrf: csrfToken(TOKEN), model: MODEL, revision: (await prompts.read(MODEL))!.revision });
  const post = (fields: Record<string, string>, restore = false, headers: Record<string, string> = {}) => fetch(
    base + "/settings/codex-base-prompt" + (restore ? "/restore" : ""), { method: "POST", redirect: "manual",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields) });
  return { dir, codexHome, base, prompts, store, settings, get, form, post };
}

describe("基础指令设置页", () => {
  it("当前模型编辑器、版本、目录比较和自动追加的只读受管预览", async () => {
    const r = await rig("<基础指令>&\n");
    const html = await r.get();
    expect(html).toContain(`codex 基础指令（${MODEL}）`);
    expect(html).toContain('action="/settings/codex-base-prompt"');
    expect(html).toContain(`name="model" value="${MODEL}"`);
    expect(html).toContain(`name="revision" value="${(await r.form()).revision}"`);
    expect(html).toContain("&lt;基础指令&gt;&amp;");
    expect(html).toContain("与目录默认一致");
    expect(html).not.toContain("与目录默认不同");
    expect(html).toContain("自动追加的 QQ 受管规则（只读）");
    expect(html).toContain("只有用户明确要求来源时才给");
    const textarea = /action="\/settings\/codex-base-prompt"[^]*?<textarea[^>]*>([^]*?)<\/textarea>/.exec(html)![1];
    expect(textarea).not.toContain("QQ 回复规则");
    expect(html.indexOf('id="codex-base-prompt"')).toBeGreaterThan(html.indexOf('id="codex-prompt"'));
    expect(html.indexOf('id="codex-base-prompt"')).toBeLessThan(html.indexOf('id="prompt"'));
  });

  it("保存保留编码换行、记录一次变更并显示差异；恢复默认有版本检查并清除差异", async () => {
    const r = await rig("\uFEFF目录默认\r\n");
    const old = await r.form();
    const saved = await r.post({ ...old, content: "新内容\n下一行\n" });
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe("/settings?ok=codexBasePrompt#codex-base-prompt");
    expect((await r.prompts.read(MODEL))!.custom).toBe("\uFEFF新内容\r\n下一行\r\n");
    expect(await r.get()).toContain("与目录默认不同");
    expect((await r.post({ ...old, content: "过期修改" })).status).toBe(409);
    expect((await r.post(old, true)).status).toBe(409);
    expect((await r.post(await r.form(), true)).status).toBe(303);
    expect((await r.prompts.read(MODEL))!.custom).toBe("\uFEFF目录默认\r\n");
    const html = await r.get();
    expect(html).not.toContain("与目录默认不同");
    expect(html).toContain(`codex 基础指令（${MODEL}）`);
    const events = r.store.events(SETTINGS_TICKET).filter(e => e.stage === "prompt_changed");
    expect(events).toHaveLength(2);
    expect(JSON.parse(events[0].detail_json)).toMatchObject({ target: "codex-base", model: MODEL, source: "dashboard",
      bytes_before: Buffer.byteLength("\uFEFF目录默认\r\n"), bytes_after: Buffer.byteLength("\uFEFF新内容\r\n下一行\r\n") });
  });

  it.each([false, true])("保存/恢复均校验 cookie、CSRF 和同源（恢复=%s）", async restore => {
    const r = await rig(), form = await r.form();
    expect((await r.post({ ...form, content: "覆盖", _csrf: "" }, restore)).status).toBe(403);
    expect((await r.post({ ...form, content: "覆盖", _csrf: "wrong" }, restore)).status).toBe(403);
    expect((await r.post({ ...form, content: "覆盖" }, restore, { Origin: "http://evil.example" })).status).toBe(403);
    expect((await r.post({ ...form, content: "覆盖" }, restore, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await r.post({ ...form, content: "覆盖" }, restore, { Cookie: "" })).status).toBe(401);
    expect((await r.prompts.read(MODEL))!.custom).toBe("目录默认\n");
    expect(r.store.events(SETTINGS_TICKET).filter(e => e.stage === "prompt_changed")).toHaveLength(0);
  });

  it("模型切换后的旧表单不写错文件，新页面跟随当前模型", async () => {
    const r = await rig(), old = await r.form();
    await r.settings.update({ codexModel: OTHER }, "test");
    const html = await r.get();
    expect(html).toContain(`codex 基础指令（${OTHER}）`);
    expect(html).toContain("其它模型默认");
    expect((await r.post({ ...old, content: "旧模型表单" })).status).toBe(409);
    expect((await r.post(old, true)).status).toBe(409);
    expect((await r.prompts.read(MODEL))!.custom).toBe("目录默认\n");
    expect((await r.prompts.read(OTHER))!.custom).toBe("其它模型默认");
  });

  it("目录不可用时显示降级；已有文件显示不可比较，恢复失败不改动", async () => {
    const missing = await rig(null);
    expect(await missing.get()).toContain("目录模板暂不可用；本轮使用 Codex 默认基础指令");
    expect(await missing.get()).not.toContain('action="/settings/codex-base-prompt"');
    const r = await rig(), form = await r.form();
    await fs.rm(path.join(r.codexHome, "models_cache.json"));
    const html = await r.get();
    expect(html).toContain("目录模板暂不可用，无法比较");
    expect(html).toContain('disabled>恢复目录默认</button>');
    expect((await r.post(form, true)).status).toBe(409);
    expect((await r.prompts.read(MODEL))!.custom).toBe("目录默认\n");
  });

  it("含秘密文件只读脱敏；提交秘密、空文本、超限及缺失版本均拒绝", async () => {
    const r = await rig(), form = await r.form();
    const secret = "base-prompt-secret-12345678"; registerSecrets([secret]);
    for (const content of [secret, "  ", "x".repeat(65537)]) {
      const response = await r.post({ ...form, content });
      expect(response.status).toBe(409);
      expect(await response.text()).not.toContain(secret);
    }
    expect((await r.post({ ...form, revision: "", content: "覆盖" })).status).toBe(409);
    const snapshot = (await r.prompts.read(MODEL))!;
    await fs.writeFile(snapshot.file, secret, "utf8");
    const html = await r.get();
    expect(html).toContain("面板只读展示脱敏版本");
    expect(html).not.toContain(secret);
    expect(html).not.toContain('action="/settings/codex-base-prompt"');
    expect(html).not.toContain('action="/settings/codex-base-prompt/restore"');
    expect(html).toContain(MANAGED_QQ_INSTRUCTIONS.split("\n")[1]);
    const current = await r.form();
    expect((await r.post({ ...current, content: "覆盖" })).status).toBe(409);
    expect((await r.post(current, true)).status).toBe(409);
  });
});

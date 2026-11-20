import { test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_PAGE_HTML } from "../src/admin/app.generated.ts";
import { bundleModule, mountDom } from "./browser-harness.mjs";

const { window, document, click } = mountDom(ADMIN_PAGE_HTML);
globalThis.__deviceCs = { epoch: 0 };
globalThis.__deviceErrors = [];
let requests = [], devices = [], firstFailure = true;
globalThis.__deviceRead = async (_schema, method, path, body) => {
  requests.push({ method, path, body });
  if (method === "GET") return { configured: true, devices };
  if (path === "/admin/devices") {
    if (firstFailure) { firstFailure = false; throw new Error("synthetic-network"); }
    const device = { ...body, state: "pairing", expiresAt: Date.now() + 10000, createdAt: Date.now(), serverId: "device-" + body.id, desktopServerId: null };
    devices = [device]; return { device, pairingUrl: "https://agent.test/admin/devices/" + body.id + "/pair#synthetic-code" };
  }
  assert.ok(path.endsWith("/revoke")); devices[0].state = "revoked"; return devices[0];
};
const { initDevices, loadDevices } = await bundleModule("browser/devices.ts", {
  "./app": 'export { $, el } from "./browser/dom.ts"; export const fail = e => globalThis.__deviceErrors.push(e), show = () => {}, readToken = () => true;',
  "./api": "export const readApi = (...args) => globalThis.__deviceRead(...args);",
  "./console": "export const cs = globalThis.__deviceCs;",
  "./mcp-servers": "export const loadMcpServers = async () => {};",
});
const node = id => document.getElementById(id);

test("真实设备表单默认只选命令行，失败重试复用设备 ID，关闭后清除配对链接", async () => {
  initDevices(); await loadDevices();
  assert.equal(node("device-desktop").hasAttribute("checked"), false);
  node("device-desktop").checked = false; node("device-name").value = "我的 Mac";
  await click(node("device-create")); assert.equal(globalThis.__deviceErrors.length, 1);
  const original = requests.find(request => request.method === "POST").body;
  assert.equal(original.desktop, false);
  await click(node("device-create"));
  assert.deepEqual(requests.filter(request => request.method === "POST")[1].body, original);
  assert.match(node("device-link").value, /synthetic-code$/);
  assert.ok(node("device-list").textContent.includes("我的 Mac"));
  node("device-editor").open = false; node("device-editor").dispatchEvent(new window.Event("toggle"));
  assert.equal(node("device-link").value, ""); assert.equal(node("device-pairing").hidden, true);
  const revoke = [...node("device-list").querySelectorAll("button")].find(button => button.textContent === "撤销接入");
  await click(revoke); assert.match(node("device-list").textContent, /已撤销/);
});

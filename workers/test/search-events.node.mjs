import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { parseHTML } from "linkedom";

test("管理页搜索事件展示提供方与调用次数，并保留旧事件的结果数", async () => {
  const { window } = parseHTML('<html><body><table><tbody id="events"></tbody></table></body></html>');
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.CSS = { escape: key => key };
  const app = await build({ entryPoints: ["browser/app.ts"], bundle: true, write: false, format: "esm", platform: "browser" });
  const { renderEvents } = await import("data:text/javascript;base64," + Buffer.from(app.outputFiles[0].text).toString("base64"));
  renderEvents([
    { kind: "web_search", at: 10, detail: { provider: "openai-codex", calls: 2, ms: 900, result: "ok" } },
    { kind: "web_search", at: 9, detail: { results: 5, ms: 700, result: "ok" } },
  ]);
  assert.deepEqual([...document.querySelectorAll("#events .cell-text")].map(cell => cell.textContent),
    ["openai-codex · 2 次调用 · 900 ms", "5 条结果 · 700 ms"]);
});

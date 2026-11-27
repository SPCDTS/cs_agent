import { build } from "esbuild";
import { parseHTML } from "linkedom";
import { fileURLToPath } from "node:url";

const WORKERS_DIR = fileURLToPath(new URL("..", import.meta.url));
const DOM_GLOBALS = [
  "document", "HTMLElement", "HTMLInputElement", "HTMLButtonElement",
  "HTMLSelectElement", "HTMLTextAreaElement", "HTMLTableCellElement",
  "SVGSVGElement", "Event",
];

/**
 * 挂载 linkedom DOM 到 globalThis，并修补 linkedom 在表单属性与 dialog 方法上的差异。
 */
export function mountDom(html = "<!doctype html><html><body></body></html>", { token } = {}) {
  const { window } = parseHTML(html);
  for (const key of DOM_GLOBALS) {
    if (window[key] !== undefined) globalThis[key] = window[key];
  }
  globalThis.window = window;
  globalThis.MouseEvent = window.Event;
  globalThis.CSS = { escape: value => value };

  Object.defineProperty(window.HTMLInputElement.prototype, "checked", {
    configurable: true,
    get() { return this.hasAttribute("checked"); },
    set(value) { if (value) this.setAttribute("checked", ""); else this.removeAttribute("checked"); },
  });
  Object.defineProperty(window.HTMLSelectElement.prototype, "value", {
    configurable: true,
    get() { return [...this.options].find(o => o.hasAttribute("selected"))?.value ?? this.options[0]?.value ?? ""; },
    set(value) {
      for (const o of this.options) {
        if (o.value === value) o.setAttribute("selected", "");
        else o.removeAttribute("selected");
      }
    },
  });
  for (const dialog of window.document.querySelectorAll("dialog")) {
    dialog.showModal = function () { this.open = true; };
    dialog.close = function () { this.open = false; };
  }

  const storage = new Map(token ? [["joule-admin-token", token]] : []);
  globalThis.sessionStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  };

  const settle = async (ticks = 10) => {
    for (let i = 0; i < ticks; i++) await new Promise(resolve => setImmediate(resolve));
  };
  const click = async (node, ticks = 10) => {
    node.dispatchEvent(new window.Event("click"));
    await settle(ticks);
  };
  return { window, document: window.document, storage, settle, click };
}

/**
 * 用 esbuild 打包浏览器模块，按 specifier 将指定依赖替换为测试桩后以 ESM 导入。
 */
export async function bundleModule(entry, mocks = {}) {
  const entries = Object.entries(mocks);
  const plugins = entries.length ? [{
    name: "browser-test-boundaries",
    setup(b) {
      for (const [specifier, contents] of entries) {
        const filter = new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
        const namespace = `test-mock:${specifier}`;
        b.onResolve({ filter }, args => ({ path: args.path, namespace }));
        b.onLoad({ filter: /.*/, namespace }, () => ({ contents, resolveDir: WORKERS_DIR }));
      }
    },
  }] : [];
  const target = typeof entry === "string"
    ? { entryPoints: [entry] }
    : { stdin: { contents: entry.contents, resolveDir: WORKERS_DIR } };
  const result = await build({
    absWorkingDir: WORKERS_DIR,
    ...target,
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    plugins,
  });
  return import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64"));
}

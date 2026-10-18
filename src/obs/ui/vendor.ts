/**
 * 随 npm 包分发的第三方前端资源（设计 §5.1：vis-timeline 固定版本，本地提供，不走 CDN）。
 * 固定白名单两项，启动时各读一次进内存；不按 URL 拼路径，不存在目录穿越。
 * 读取失败（未安装）时该项缺席，路由返回 404，时间线页显示降级提示。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export interface VendorAsset { type: string; body: Buffer }

const FILES: Record<string, [string, string]> = {
  'vis-timeline.js': ['standalone/umd/vis-timeline-graph2d.min.js', 'text/javascript; charset=utf-8'],
  'vis-timeline.css': ['styles/vis-timeline-graph2d.min.css', 'text/css; charset=utf-8'],
};

/**
 * standalone 包内的 styleInject 会追加不带 nonce 的 <style>，被 CSP 拒绝并在控制台报错；同样的样式已由
 * 同源 vis-timeline.css 提供，所以把唯一的注入入口改成不执行。只做精确且唯一的替换：版本变化找不到时
 * 原样提供（功能不受影响，只是控制台会有 CSP 报告），测试会因 STYLE_INJECT_DISABLED 为 false 失败提醒。
 */
const INJECT = 'if(t&&"undefined"!=typeof document){var n=document.head';
export let STYLE_INJECT_DISABLED = false;
function disableStyleInject(js: string): string {
  const at = js.indexOf(INJECT);
  if (at < 0 || js.indexOf(INJECT, at + 1) >= 0) return js;
  STYLE_INJECT_DISABLED = true;
  return js.slice(0, at) + 'if(!1){var n=document.head' + js.slice(at + INJECT.length);
}

function load(): Record<string, VendorAsset> {
  const out: Record<string, VendorAsset> = {};
  let root: string;
  try { root = path.dirname(createRequire(import.meta.url).resolve('vis-timeline/package.json')); } catch { return out; }
  for (const [name, [rel, type]] of Object.entries(FILES)) {
    try {
      // 去掉 sourceMappingURL：.map 文件不在白名单内，避免浏览器开发者工具反复请求 404。
      let text = readFileSync(path.join(root, rel), 'utf8').replace(/\n?\/[/*]# sourceMappingURL=[^\n]*\n?$/, '\n');
      if (name === 'vis-timeline.js') text = disableStyleInject(text);
      out[name] = { type, body: Buffer.from(text, 'utf8') };
    } catch { /* 缺席即 404 */ }
  }
  return out;
}

export const VENDOR: Readonly<Record<string, VendorAsset>> = Object.freeze(load());
/** 资源存在时返回，否则 undefined；只认白名单键（own property），不解析路径。 */
export const vendorAsset = (name: string): VendorAsset | undefined => Object.hasOwn(VENDOR, name) ? VENDOR[name] : undefined;
export const VENDOR_CACHE = 'public, max-age=86400';

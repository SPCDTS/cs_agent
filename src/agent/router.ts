import { ASPECTS, type ImageOptions } from "./image-options.js";
/**
 * 规则分流器（设计 §4.1，无模型）：
 * - 输入是 bridge 计算的分流文本 route_text（已跳过开头真实的 at / reply 段，见 qq/policy.ts），这里只去首尾空白；
 *   用户亲手输入的 "[at]" 字样不做任何特殊处理；
 * - 以 IMAGE_PREFIXES 中任一前缀开头（逐字匹配，大小写与全/半角按配置原样）→ 生图，解析前导内联选项，余下原文作为提示词；
 *   提示词为空 → 固定用法提示；
 * - 否则整条原文交给执行 agent。
 */

export const DEFAULT_IMAGE_PREFIXES = ["奶龙:", "奶龙："];
export const IMAGE_USAGE_REPLY = "奶龙: 后面写要画的内容";

export type RouteResult =
  | { route: "image"; prefix: string; prompt: string; options: ImageOptions }
  | { route: "image_usage"; prefix: string }
  | { route: "agent"; text: string };

export type RouteName = RouteResult["route"];

/** 逗号分隔的前缀列表；每项去首尾空白，空项丢弃；整体为空时用默认值。 */
export function parseImagePrefixes(raw: string | undefined): string[] {
  const list = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : [...DEFAULT_IMAGE_PREFIXES];
}

/**
 * 仅用于没有 route_text 的旧数据（v2 票据文档、迁移前的票据行）：去掉开头渲染出的 [at] / [reply] 占位。
 * 新消息一律用 bridge 的 route_text，不经过这里。
 */
export function legacyRouteText(text: string): string {
  return text.replace(/^(?:\s*\[(?:at|reply)\])+/, "");
}

/** routeText：InboundMessage.route_text（只去首尾空白后逐字匹配前缀）。 */
export function routeMessage(routeText: string, prefixes: readonly string[] = DEFAULT_IMAGE_PREFIXES, images: readonly string[] = []): RouteResult {
  const t = routeText.trim();
  // 较长的前缀优先（避免一个前缀是另一个的前缀时截错）
  const prefix = [...prefixes].sort((a, b) => b.length - a.length).find((p) => p && t.startsWith(p));
  if (prefix === undefined) return { route: "agent", text: routeText };
  const options = parseInlineImageOptions(t.slice(prefix.length));
  if (images.length) options.reference_images = [...images];
  return options.prompt ? { route: 'image', prefix, prompt: options.prompt, options } : { route: 'image_usage', prefix };
}

/** 只消费提示词前连续的已知选项；首个未知词起完整保留，正文里的参数字样不再解析。 */
export function parseInlineImageOptions(text: string): ImageOptions {
  let prompt = text.trim();
  const opts: ImageOptions = { prompt: '' };
  const aliases: Record<string, ImageOptions['aspect']> = { 横: '16:9', 竖: '9:16', 方: '1:1' };
  for (;;) {
    const token = /^\S+/.exec(prompt)?.[0];
    if (!token) break;
    if ((ASPECTS as readonly string[]).includes(token)) opts.aspect = token as ImageOptions['aspect'];
    else if (Object.hasOwn(aliases, token)) opts.aspect = aliases[token];
    else if (token === '2k' || token === '2mp') opts.size = token;
    else if (/^x[2-4]$/.test(token)) opts.count = Number(token[1]);
    else if (token === '透明') opts.transparent = true;
    else break;
    prompt = prompt.slice(token.length).trimStart();
  }
  return { ...opts, prompt };
}

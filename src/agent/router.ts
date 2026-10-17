/**
 * 规则分流器（设计 §4.1，无模型）：
 * - 输入是 bridge 计算的分流文本 route_text（已跳过开头真实的 at / reply 段，见 qq/policy.ts），这里只去首尾空白；
 *   用户亲手输入的 "[at]" 字样不做任何特殊处理；
 * - 以 IMAGE_PREFIXES 中任一前缀开头（逐字匹配，大小写与全/半角按配置原样）→ 生图，前缀之后的全部文本即提示词；
 *   提示词为空 → 固定用法提示；
 * - 否则整条原文交给执行 agent。
 */

export const DEFAULT_IMAGE_PREFIXES = ["奶龙:", "奶龙："];
export const IMAGE_USAGE_REPLY = "奶龙: 后面写要画的内容";

export type RouteResult =
  | { route: "image"; prefix: string; prompt: string }
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
export function routeMessage(routeText: string, prefixes: readonly string[] = DEFAULT_IMAGE_PREFIXES): RouteResult {
  const t = routeText.trim();
  // 较长的前缀优先（避免一个前缀是另一个的前缀时截错）
  const prefix = [...prefixes].sort((a, b) => b.length - a.length).find((p) => p && t.startsWith(p));
  if (prefix === undefined) return { route: "agent", text: routeText };
  const prompt = t.slice(prefix.length).trim();
  return prompt ? { route: "image", prefix, prompt } : { route: "image_usage", prefix };
}

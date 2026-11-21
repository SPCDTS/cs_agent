// QQ 与网页气泡均按纯文本展示；联网搜索常附带私用区内部引用标记（\uE200…\uE201）及 utm_source=openai，发送前统一清洗。
// 中文标点（含全角括号）紧跟在 URL 后面很常见，不能当成 URL 的一部分。
const URL_TEXT = /https?:\/\/[^\s<>()\[\]"'`　-〿＀-￯\uE200-\uE202]+/g;
const MARKDOWN_LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
const HAS_PUA = /[\uE200-\uE202]/;
const ENTITY_TAG = /\uE200entity\uE202([^\uE201]*)\uE201/g;
const PUA_TAG = /([ \t]*)\uE200[^\uE201]*\uE201/g;
const UNCLOSED_PUA_TAG = /[ \t]*\uE200[^\uE201\r\n]*$/gm;
const STRAY_PUA = /[\uE200-\uE202]/g;
const TRAILING_PUNCT_OR_SPACE = /^(?:$|[\s.,;:!?，。；：！？、）》」』\]\)])/;

/** 剥离服务端联网搜索注入的私用区内部标记（cite / filecite / navlist 等）；entity 标签保留展示名。 */
export function stripProviderMarkup(text: string): string {
  if (!HAS_PUA.test(text)) return text;
  return text
    .replace(ENTITY_TAG, (_match, raw: string) => {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed) && typeof parsed[1] === "string") return parsed[1];
      } catch {}
      return "";
    })
    .replace(PUA_TAG, (match, leadingSpace: string, offset: number, source: string) => {
      if (!leadingSpace) return "";
      const after = source.slice(offset + match.length);
      return TRAILING_PUNCT_OR_SPACE.test(after) ? "" : leadingSpace;
    })
    .replace(UNCLOSED_PUA_TAG, "")
    .replace(STRAY_PUA, "");
}

/** 去掉 utm_* 查询参数；按字符串拆分而不是经 URL 重新序列化，其他参数的编码保持原样。 */
export function stripTracking(url: string): string {
  const hash = url.indexOf("#"), fragment = hash < 0 ? "" : url.slice(hash);
  const base = hash < 0 ? url : url.slice(0, hash), mark = base.indexOf("?");
  if (mark < 0) return url;
  const kept = base.slice(mark + 1).split("&").filter(part => part && !/^utm_/i.test(part));
  return base.slice(0, mark) + (kept.length ? "?" + kept.join("&") : "") + fragment;
}

export function cleanOutgoing(text: string): string {
  return stripProviderMarkup(text)
    .replace(MARKDOWN_LINK, (_match, label: string, url: string) => {
      const clean = stripTracking(url);
      return label.trim() === url || label.trim() === clean ? clean : `${label}（${clean}）`;
    })
    .replace(URL_TEXT, stripTracking);
}

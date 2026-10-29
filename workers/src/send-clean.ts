// QQ 不渲染 Markdown；联网搜索的结果又常带 utm_source=openai。发送前把这两样清掉，其余文字原样保留。
// 中文标点（含全角括号）紧跟在 URL 后面很常见，不能当成 URL 的一部分。
const URL_TEXT = /https?:\/\/[^\s<>()\[\]"'`　-〿＀-￯]+/g;
const MARKDOWN_LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

/** 去掉 utm_* 查询参数；按字符串拆分而不是经 URL 重新序列化，其他参数的编码保持原样。 */
export function stripTracking(url: string): string {
  const hash = url.indexOf("#"), fragment = hash < 0 ? "" : url.slice(hash);
  const base = hash < 0 ? url : url.slice(0, hash), mark = base.indexOf("?");
  if (mark < 0) return url;
  const kept = base.slice(mark + 1).split("&").filter(part => part && !/^utm_/i.test(part));
  return base.slice(0, mark) + (kept.length ? "?" + kept.join("&") : "") + fragment;
}

export function cleanOutgoing(text: string): string {
  return text
    .replace(MARKDOWN_LINK, (_match, label: string, url: string) => {
      const clean = stripTracking(url);
      return label.trim() === url || label.trim() === clean ? clean : `${label}（${clean}）`;
    })
    .replace(URL_TEXT, stripTracking);
}

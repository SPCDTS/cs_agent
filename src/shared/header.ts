export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  let cut = t.slice(0, Math.max(0, max - 1));
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

const HEADER_LABEL_RE = /\[(来源|引用(?:\s+#[^\]\r\n]*)?)\]/g;

/** 不可信头部字段折成单行，并中和来源、引用标签。 */
export function headerField(text: string, max: number): string {
  const line = text.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim();
  return clip(line.replace(HEADER_LABEL_RE, "($1)"), max);
}

export function headerNickname(nickname: string): string {
  return headerField(nickname, 40);
}

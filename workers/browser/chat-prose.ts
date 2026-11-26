import { el, type Child } from "./dom";

// 只把常见的排版标记转换成 DOM；HTML、外链和不认识的格式均保留文字。
function inline(text: string): Child[] {
  const parts: Child[] = [];
  let offset = 0;
  for (const match of text.matchAll(/(`([^`\n]+)`|\*\*([^*\n]+)\*\*)/g)) {
    parts.push(text.slice(offset, match.index), match[2] !== undefined ? el("code", { text: match[2] }) : el("strong", { text: match[3] }));
    offset = match.index + match[0].length;
  }
  parts.push(text.slice(offset));
  return parts;
}

export function chatProse(text: string): HTMLElement {
  const prose = el("div", { className: "chat-prose" });
  const lines = text.split(/\r?\n/);
  let paragraph: string[] = [];
  let list: HTMLOListElement | HTMLUListElement | undefined;
  function endParagraph() {
    if (paragraph.length) prose.append(el("p", {}, inline(paragraph.join("\n"))));
    paragraph = [];
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const item = /^ {0,3}(?:([-*+])|(\d{1,6})[.)])\s+(.+)$/.exec(line);
    if (item) {
      endParagraph();
      const tag = item[1] ? "ul" : "ol";
      if (list?.localName !== tag) {
        list = el(tag, { start: tag === "ol" ? item[2] : undefined });
        prose.append(list);
      }
      list.append(el("li", {}, inline(item[3]!)));
      continue;
    }
    list = undefined;
    const fence = /^ {0,3}(`{3,})([\w+.#-]*)\s*$/.exec(line);
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (fence) {
      endParagraph();
      const begin = ++i;
      while (i < lines.length) {
        const close = /^ {0,3}(`{3,})\s*$/.exec(lines[i]!);
        if (close && close[1]!.length >= fence[1]!.length) break;
        i++;
      }
      const code = el("pre", {}, [el("code", { text: lines.slice(begin, i).join("\n") })]);
      prose.append(fence[2] ? el("figure", {}, [el("figcaption", { text: fence[2] }), code]) : code);
    } else if (heading) {
      endParagraph();
      prose.append(el("h4", {}, inline(heading[1]!)));
    } else if (line.startsWith("> ")) {
      endParagraph();
      const quote = [line.slice(2)];
      while (lines[i + 1]?.startsWith("> ")) quote.push(lines[++i]!.slice(2));
      prose.append(el("blockquote", {}, inline(quote.join("\n"))));
    } else if (line.trim()) paragraph.push(line);
    else endParagraph();
  }
  endParagraph();
  return prose;
}

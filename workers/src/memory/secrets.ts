// 沿用 Docker 的凭据形态检测；拒绝保存原文，不能用脱敏后的句子冒充原记忆。
export function redactSecrets(text: string): string {
  let out = redactMultilineSecrets(text);
  // 先处理整行认证头、带引号的完整值（含空格/转义），再处理无引号的令牌。
  out = out.replace(/(^|\r?\n)([ \t]*(?:Cookie|Set-Cookie|Authorization)\s*:\s*)[^\r\n]*/gi, '$1$2[已隐藏]')
    .replace(/((?:api[_-]?key|apikey|token|secret|password|passwd|authorization|cookie|credentials?)["']?\s*[=:]\s*)"(?:\\.|[^"\\])*"/gi, '$1"[已隐藏]"')
    .replace(/((?:api[_-]?key|apikey|token|secret|password|passwd|authorization|cookie|credentials?)["']?\s*[=:]\s*)'(?:\\.|[^'\\])*'/gi, "$1'[已隐藏]'")
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[已隐藏]')
    .replace(/((?:api[_-]?key|apikey|token|secret|password|passwd|authorization|cookie|credentials?)["']?\s*[=:]\s*["']?)[^\s"'&,};]+/gi, '$1[已隐藏]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[已隐藏]')
    .replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"']+/g, raw => {
      try { const url = new URL(raw); if (url.username || url.password) {
        url.username = ''; url.password = ''; return url.toString();
      } } catch { return raw.replace(/(\/\/)[^/]*@/, '$1[已隐藏]@'); }
      return raw;
    });
  return out;
}

export function containsSecret(text: string): boolean {
  return redactSecrets(text) !== text;
}

const secretKey = String.raw`(?:api[_-]?key|apikey|token|secret|password|passwd|authorization|cookie|credentials?)`;
/** 先处理结构化多行标量，不能只隐藏 YAML 的 | / > 而留下缩进内容。 */
function redactMultilineSecrets(text: string): string {
  const prefix = String.raw`${secretKey}["']?\s*[=:]\s*`;
  const double = /"(?:\\[\s\S]|[^"\\])*"/;
  const single = /'(?:\\[\s\S]|''|[^'\\])*'/;
  let out = text.replace(new RegExp(`(${prefix})${double.source}`, "gi"), '$1"[已隐藏]"')
    .replace(new RegExp(`(${prefix})${single.source}`, "gi"), "$1'[已隐藏]'");
  // 未闭合引号没有可靠的值结束边界；保留前文，明确隔离其后内容而不是泄漏延续值。
  for (const match of out.matchAll(new RegExp(`(${prefix})(["'])`, "gi"))) {
    const at = match.index + match[1]!.length;
    if (!new RegExp("^" + (match[2] === '"' ? double.source : single.source)).test(out.slice(at))) {
      out = out.slice(0, at) + "[已隐藏]\n[凭据值未闭合，后续内容已隔离]";
      break;
    }
  }
  const lines = out.split("\n"), keyLine = new RegExp(String.raw`^([ \t]*(?:-[ \t]+)?)["']?[\w.-]*${secretKey}["']?[ \t]*[:=][ \t]*(.*)$`, "i");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, ""), match = keyLine.exec(line);
    if (!match) continue;
    const indent = match[1]!.replace(/\t/g, "    ").length;
    let end = i + 1, content = false;
    for (; end < lines.length; end++) {
      const next = lines[end]!;
      if (!next.trim()) continue;
      if (/^[ \t]*/.exec(next)![0].replace(/\t/g, "    ").length <= indent) break;
      content = true;
    }
    if (content) {
      lines[i] = line.slice(0, line.length - match[2]!.length) + "[已隐藏]" + (lines[i]!.endsWith("\r") ? "\r" : "");
      lines.splice(i + 1, end - i - 1);
    }
  }
  return lines.join("\n");
}

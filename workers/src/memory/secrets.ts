// 沿用 Docker 的凭据形态检测；拒绝保存原文，不能用脱敏后的句子冒充原记忆。
export function containsSecret(text: string): boolean {
  let out = text;
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
  return out !== text;
}

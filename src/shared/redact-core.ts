/** 所有观测出口共用；先替换秘密再截断，避免保存凭据前半段。 */
const secrets = new Set<string>();
const temporarySecrets = new Map<string, number>();
let saturationWarned = false;
const allSecrets = () => [...secrets, ...temporarySecrets.keys()];
export const sensitive = /(?:token|secret|password|passwd|authorization|cookie|credential|api[_-]?key|apikey|^key$)/i;
const scopeKey = (v: unknown) => typeof v === 'string' && /^(owner|shared|(?:group|private):\d+)$/.test(v);
const safeMetadata = (key: string, value: unknown) =>
  (typeof value === 'number' && /tokens/i.test(key)) ||
  (/^(thread_key|conversation_key|key)$/.test(key) && scopeKey(value)) ||
  (key === 'keys' && Array.isArray(value) && value.every(scopeKey));
export function registerSecretsCore(values: Iterable<string | undefined>, onSaturation: () => void): void {
  for (const value of values) {
    if (!value || value.length > 16384 || secrets.has(value)) continue;
    if (secrets.size < 2048) secrets.add(value);
    else if (!saturationWarned) {
      saturationWarned = true;
      // 保留异步告警时机，日志出口由门面注入，核心不依赖日志。
      queueMicrotask(onSaturation);
    }
  }
}
/** 临时秘密不占长期容量；重复注册按引用计数，dispose 可重复调用。 */
export function registerTemporarySecrets(values: Iterable<string | undefined>): () => void {
  const registered = new Set([...values].filter((v): v is string => !!v && v.length <= 16384));
  for (const value of registered) temporarySecrets.set(value, (temporarySecrets.get(value) ?? 0) + 1);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const value of registered) {
      const count = temporarySecrets.get(value)! - 1;
      if (count) temporarySecrets.set(value, count); else temporarySecrets.delete(value);
    }
  };
}
export function redactText(text: string, limit = 500): string {
  let out = text;
  for (const secret of allSecrets().sort((a, b) => b.length - a.length)) out = out.split(secret).join('[已隐藏]');
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
  return out.length > limit ? out.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '') + '…' : out;
}
/** 提示词编辑器与记忆写入共用的拒绝规则：脱敏会改动原文（含已注册秘密或凭据形态）即视为含秘密。 */
export function containsSecret(text: string): boolean {
  return redactText(text, Number.MAX_SAFE_INTEGER) !== text;
}
export function redact(value: unknown, limit = 500, depth = 0): unknown {
  if (depth > 8) return '[深度上限]';
  if (value instanceof Error) return redactText(value.message, limit);
  if (typeof value === 'string') return redactText(value, limit);
  if (Array.isArray(value)) return value.slice(0, 100).map(v => redact(v, limit, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 100).map(([k, v]) =>
    [redactText(k, 128), (sensitive.test(k) || k === 'keys') && !safeMetadata(k, v)
      ? '[已隐藏]' : redact(v, limit, depth + 1)]));
  return typeof value === 'bigint' ? String(value) : value;
}

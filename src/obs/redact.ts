/** 所有观测出口共用；先替换秘密再截断，避免保存凭据前半段。 */
const secrets = new Set<string>();
const sensitive = /(?:token|secret|password|passwd|authorization|cookie|credential|api[_-]?key|apikey|^key$)/i;
const scopeKey = (v: unknown) => typeof v === 'string' && /^(owner|shared|(?:group|private):\d+)$/.test(v);
const safeMetadata = (key: string, value: unknown) =>
  (typeof value === 'number' && /tokens/i.test(key)) ||
  (/^(thread_key|conversation_key|key)$/.test(key) && scopeKey(value)) ||
  (key === 'keys' && Array.isArray(value) && value.every(scopeKey));
export function registerSecrets(values: Iterable<string | undefined>): void {
  for (const value of values) if (value && value.length <= 16384 && secrets.size < 2048) secrets.add(value);
}
function registerEnvSecrets(env: NodeJS.ProcessEnv = process.env): void {
  registerSecrets(Object.entries(env).filter(([k]) => sensitive.test(k)).map(([, v]) => v));
}
export function redactText(text: string, limit = 500): string {
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(secret).join('[已隐藏]');
  out = out.replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[已隐藏]')
    .replace(/((?:api[_-]?key|token|secret|password|authorization)["']?\s*[=:]\s*["']?)[^\s"'&,}]+/gi, '$1[已隐藏]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[已隐藏]')
    .replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"']+/g, raw => {
      try { const url = new URL(raw); if (url.username || url.password) {
        url.username = ''; url.password = ''; return url.toString();
      } } catch { return raw.replace(/(\/\/)[^/]*@/, '$1[已隐藏]@'); }
      return raw;
    });
  return out.length > limit ? out.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '') + '…' : out;
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
registerEnvSecrets();

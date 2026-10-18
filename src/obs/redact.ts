import { log } from '../log.js';

/** 所有观测出口共用；先替换秘密再截断，避免保存凭据前半段。 */
const secrets = new Set<string>();
const temporarySecrets = new Map<string, number>();
let saturationWarned = false;
const allSecrets = () => [...secrets, ...temporarySecrets.keys()];
const sensitive = /(?:token|secret|password|passwd|authorization|cookie|credential|api[_-]?key|apikey|^key$)/i;
const scopeKey = (v: unknown) => typeof v === 'string' && /^(owner|shared|(?:group|private):\d+)$/.test(v);
const safeMetadata = (key: string, value: unknown) =>
  (typeof value === 'number' && /tokens/i.test(key)) ||
  (/^(thread_key|conversation_key|key)$/.test(key) && scopeKey(value)) ||
  (key === 'keys' && Array.isArray(value) && value.every(scopeKey));
export function registerSecrets(values: Iterable<string | undefined>): void {
  for (const value of values) {
    if (!value || value.length > 16384 || secrets.has(value)) continue;
    if (secrets.size < 2048) secrets.add(value);
    else if (!saturationWarned) {
      saturationWarned = true;
      // 环境初始化也会注册秘密，延后日志以免与 log 模块的初始化循环相撞。
      queueMicrotask(() => log.warn("长期秘密表已满，新的长期秘密未注册"));
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
function registerEnvSecrets(env: NodeJS.ProcessEnv = process.env): void {
  registerSecrets(Object.entries(env).filter(([k]) => sensitive.test(k)).map(([, v]) => v));
}
/** 子进程不继承凭据名称，也不继承以普通变量名保存的已注册秘密。 */
export function withoutSecretEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && !sensitive.test(entry[0]) &&
    !allSecrets().some(secret => entry[1]!.includes(secret))));
}
export function redactText(text: string, limit = 500): string {
  let out = text;
  for (const secret of allSecrets().sort((a, b) => b.length - a.length)) out = out.split(secret).join('[已隐藏]');
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

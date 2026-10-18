export interface Failure { kind: 'auth'|'network'|'rate_limit'|'other'; provider: string; status: number | null }

/** 在执行边界归类原始错误；告警只消费分类，不再匹配脱敏后的自由文本。 */
export function classifyFailure(error: unknown, provider: string): Failure {
  const value = error && typeof error === 'object' ? error as Record<string,unknown> : {};
  const nested = value.cause && typeof value.cause === 'object' ? value.cause as Record<string,unknown> : {};
  const text = [value.message,value.code,nested.message,nested.code,typeof error === 'string' ? error : ''].filter(Boolean).join(' ');
  const rawStatus = Number(value.status ?? value.statusCode ?? nested.status ?? /\b(401|403|429|5\d\d)\b/.exec(text)?.[1]);
  const status = Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : null;
  const kind = status === 401 || status === 403 || /unauthorized|authentication|invalid.api.key|鉴权|认证/i.test(text) ? 'auth'
    : status === 429 || /rate.?limit|too many requests/i.test(text) ? 'rate_limit'
    : (status !== null && status >= 500) || /ECONN|ENOTFOUND|ETIMEDOUT|fetch failed|network|timeout|timed out/i.test(text) ? 'network' : 'other';
  return {kind,provider,status};
}

export function diagnosticFailure(result: {diagnostics?: readonly {message: string}[]; output?: readonly unknown[]}, provider: string): Failure {
  const failures = (result.diagnostics ?? []).map(d => classifyFailure(d.message,provider));
  return failures.find(f=>f.kind==='auth') ?? failures.find(f=>f.kind!=='other') ?? classifyFailure('',provider);
}

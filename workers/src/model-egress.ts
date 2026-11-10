// 仅供管理员手动诊断：从实际 owner DO 发起固定的公开 GET，不读取模型凭据。
const TARGETS = [
  { id: "openai-api", url: "https://api.openai.com/cdn-cgi/trace", format: "trace" },
  { id: "openai-auth", url: "https://auth.openai.com/cdn-cgi/trace", format: "trace" },
  { id: "cloudflare", url: "https://www.cloudflare.com/cdn-cgi/trace", format: "trace" },
  { id: "ipify", url: "https://api.ipify.org?format=json", format: "json" },
] as const;
const MAX_BYTES = 8192;
const clean = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9.:_-]{1,100}$/.test(value) ? value : undefined;

async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "", size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) return text + decoder.decode();
      size += part.value.byteLength;
      if (size > MAX_BYTES) throw new Error("body_limit");
      text += decoder.decode(part.value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => {}); }
}

export async function modelEgressDiagnostics(fetcher: typeof fetch = fetch) {
  const checkedAt = new Date().toISOString();
  const probes = await Promise.all(TARGETS.map(async target => {
    const startedAt = Date.now();
    try {
      const response = await fetcher(target.url, { method: "GET", redirect: "manual", headers: { Accept: "text/plain, application/json" }, signal: AbortSignal.timeout(8000) });
      const body = await boundedText(response);
      let fields: Record<string, unknown> = {};
      if (response.ok) {
        if (target.format === "trace") fields = Object.fromEntries(body.split(/\r?\n/).flatMap(line => {
          const equal = line.indexOf("="); return equal < 0 ? [] : [[line.slice(0, equal), line.slice(equal + 1)]];
        }));
        else { try { const value: unknown = JSON.parse(body); if (value && typeof value === "object") fields = value as Record<string, unknown>; } catch {} }
      }
      // 只返回网络诊断字段，不返回响应正文、Cookie 或认证头。
      return { target: target.id, url: target.url, status: response.status, durationMs: Date.now() - startedAt,
        ray: clean(response.headers.get("cf-ray")), ip: clean(fields.ip), country: clean(fields.loc), colo: clean(fields.colo),
        sharedWorkerAddress: fields.ip === "2a06:98c0:3600::103" };
    } catch (error) {
      return { target: target.id, url: target.url, durationMs: Date.now() - startedAt,
        error: error instanceof Error && error.message === "body_limit" ? "body_limit" : "request_failed" };
    }
  }));
  return { checkedAt, executionContext: "ThreadDO/owner", authenticatedOpenAIRequest: false, probes };
}

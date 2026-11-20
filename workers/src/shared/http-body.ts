export type BodyLimitKind = "too_large" | "missing_body" | "timeout" | "invalid_encoding" | "invalid_json";

export class BodyLimitError extends Error {
  constructor(readonly kind: BodyLimitKind) {
    super(kind);
  }
}

export interface ReadBodyOptions {
  maxBytes: number;
  /** Default true: check Content-Length header when valid numeric. Pass "strict" to also reject malformed Content-Length. */
  checkContentLength?: boolean | "strict";
  /** Default false: throw BodyLimitError("missing_body") when body is null; otherwise return empty bytes. */
  requireBody?: boolean;
  /** Optional stream read timeout in ms; throws BodyLimitError("timeout"). */
  timeoutMs?: number;
}

/** 流式限流读取 Request/Response 字节流，超限立即取消并在 finally 释放 reader 锁。 */
export async function readBoundedBytes(message: Request | Response, options: ReadBodyOptions): Promise<Uint8Array> {
  const check = options.checkContentLength ?? true;
  if (check !== false) {
    const raw = message.headers.get("content-length");
    if (raw !== null) {
      const tooLarge = check === "strict"
        ? !/^\d{1,10}$/.test(raw) || Number(raw) > options.maxBytes
        : Number.isFinite(Number(raw)) && Number(raw) > options.maxBytes;
      if (tooLarge) {
        await message.body?.cancel().catch(() => {});
        throw new BodyLimitError("too_large");
      }
    }
  }
  if (!message.body) {
    if (options.requireBody) throw new BodyLimitError("missing_body");
    return new Uint8Array(0);
  }
  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = options.timeoutMs === undefined ? undefined : new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void reader.cancel().catch(() => {});
      reject(new BodyLimitError("timeout"));
    }, options.timeoutMs);
  });
  try {
    for (;;) {
      const part = timeout ? await Promise.race([reader.read(), timeout]) : await reader.read();
      if (part.done) { done = true; break; }
      size += part.value.byteLength;
      if (size > options.maxBytes) throw new BodyLimitError("too_large");
      chunks.push(part.value);
    }
  } finally {
    clearTimeout(timer);
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readBoundedText(
  message: Request | Response,
  options: ReadBodyOptions & { fatal?: boolean; encoding?: string },
): Promise<string> {
  const bytes = await readBoundedBytes(message, options);
  try {
    return new TextDecoder(options.encoding ?? "utf-8", options.fatal ? { fatal: true, ignoreBOM: false } : undefined).decode(bytes);
  } catch {
    throw new BodyLimitError("invalid_encoding");
  }
}

export async function readBoundedJson(
  message: Request | Response,
  options: ReadBodyOptions & { fatal?: boolean },
): Promise<unknown> {
  const text = await readBoundedText(message, options);
  try {
    return JSON.parse(text);
  } catch {
    throw new BodyLimitError("invalid_json");
  }
}

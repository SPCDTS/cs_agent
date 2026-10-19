import type { ServerResponse } from 'node:http';
import { createHmac } from 'node:crypto';

/** SSE 写队列：未写出字节（队列 + socket 缓冲）超过上限，或一次 drain 等待超过时限才断开慢客户端。 */
const SSE_MAX_PENDING = 2 * 1024 * 1024;
const SSE_DRAIN_TIMEOUT_MS = 10_000;

export interface SseWriter { send(frame: string): void }
/** 按序写出 SSE 帧；write 返回 false 是正常背压，等待 drain 而不是断开。 */
export function sseWriter(res: ServerResponse, maxPending = SSE_MAX_PENDING, drainTimeoutMs = SSE_DRAIN_TIMEOUT_MS): SseWriter {
  const queue: string[] = [];
  let queued = 0, flushing = false, closed = false;
  res.on('close', () => { closed = true; queue.length = 0; queued = 0; });
  const drained = () => new Promise<boolean>(resolve => {
    const done = (ok: boolean) => { clearTimeout(timer); res.off('drain', onDrain); res.off('close', onClose); resolve(ok); };
    const onDrain = () => done(true), onClose = () => done(false);
    const timer = setTimeout(() => done(false), drainTimeoutMs);
    res.on('drain', onDrain); res.on('close', onClose);
  });
  async function flush(): Promise<void> {
    if (flushing) return;
    flushing = true;
    try {
      while (queue.length && !closed) {
        const frame = queue.shift()!; queued -= Buffer.byteLength(frame);
        if (!res.write(frame) && !closed && !await drained()) { if (!closed) res.destroy(); return; }
      }
    } finally { flushing = false; }
  }
  return {
    send(frame) {
      if (closed) return;
      const bytes = Buffer.byteLength(frame);
      if (queued + bytes + res.writableLength > maxPending) { res.destroy(); return; }
      queue.push(frame); queued += bytes; void flush();
    },
  };
}

/** 由访问口令派生的 CSRF 令牌：表单隐藏字段 + 服务端比对；不知道口令无法伪造。 */
export function csrfToken(obsToken: string): string { return createHmac('sha256', obsToken).update('cs-agent-dashboard-csrf-v1').digest('base64url'); }

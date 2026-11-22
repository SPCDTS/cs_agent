import { AsyncLocalStorage } from "node:async_hooks";

const ALARM_WAIT_OBSERVER = new AsyncLocalStorage<(waitMs: number) => void>();

export function withAlarmWaitObserver<T>(observer: (waitMs: number) => void, run: () => T): T {
  return ALARM_WAIT_OBSERVER.run(observer, run);
}

/** 在原执行 DO 的新 alarm 事件中发出模型请求，不增加 DO 或转发服务。 */
export class ModelAlarm {
  private readonly requests = new Set<() => Promise<void>>();
  constructor(private readonly ctx: DurableObjectState) {}
  get pending() { return this.requests.size > 0; }
  readonly fetch: typeof fetch = async (input, init) => {
    const onWait = ALARM_WAIT_OBSERVER.getStore();
    const request = new Request(input, init), signal = request.signal;
    signal.throwIfAborted();
    const body = request.body ? await request.arrayBuffer() : undefined;
    const enqueuedAt = Date.now();
    const result = Promise.withResolvers<Response>();
    const run = async () => {
      try {
        signal.throwIfAborted();
        const waitMs = Math.max(0, Date.now() - enqueuedAt);
        onWait?.(waitMs);
        // 所有准备工作已在入队前完成；这里的第一项 I/O 就是上游请求。
        const response = await fetch(request.url, { method: request.method, headers: request.headers, body, signal, redirect: "manual" });
        result.resolve(response);
      } catch (error) { result.reject(error); }
    };
    const abort = () => { this.requests.delete(run); result.reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else { this.requests.add(run); void this.ctx.storage.setAlarm(Date.now()).catch(result.reject); }
    try { return await result.promise; }
    finally { this.requests.delete(run); signal.removeEventListener("abort", abort); }
  };
  /** 必须在 alarm() 的第一行调用，不能先 await 配置、存储或其他 RPC。 */
  dispatch(): void {
    const requests = [...this.requests];
    this.requests.clear();
    for (const run of requests) this.ctx.waitUntil(run());
  }
}

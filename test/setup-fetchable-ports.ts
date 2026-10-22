/**
 * 测试进程里 listen(0) 只拿 fetch 可访问的端口。
 *
 * 部分 Windows 机器的 TCP 动态端口范围从 1024 开始（`netsh int ipv4 show dynamicport tcp`），
 * 系统分配的端口偶尔落在 Fetch 规范的 bad ports（如 6000、6665–6669、10080）上，undici 随即以
 * "fetch failed"（cause: bad port）拒绝请求，表现为 HTTP 测试随机失败。这里包装 net.Server#listen：
 * 端口 0 分到被禁端口时静默关闭并重新 listen(0)，调用方只会看到一次正常的 'listening'。
 */
import net, { type AddressInfo } from "node:net";

// https://fetch.spec.whatwg.org/#port-blocking 中高于 1023 的端口（低端口不在动态范围内）
const FETCH_BLOCKED_PORTS = new Set([1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);

const listen = net.Server.prototype.listen;
const PATCHED = Symbol.for("cs-agent.test.fetchable-listen");

const isPortZero = (first: unknown) => first === 0 || first === "0"
  || (typeof first === "object" && first !== null && "port" in first && Number((first as { port?: unknown }).port) === 0);

if (!(listen as unknown as Record<symbol, boolean>)[PATCHED]) {
  const patched = function (this: net.Server, ...args: unknown[]) {
    if (!isPortZero(args[0])) return listen.apply(this, args as never);
    const server = this;
    const retryArgs = args.filter(arg => typeof arg !== "function");
    const emit = server.emit;
    let pendingClose = 0, settled = false;
    server.emit = function (this: net.Server, event: string | symbol, ...rest: unknown[]) {
      if (event === "listening" && !settled) {
        const port = (server.address() as AddressInfo | null)?.port;
        if (port !== undefined && FETCH_BLOCKED_PORTS.has(port)) {
          pendingClose++;
          server.close();
          listen.apply(server, retryArgs as never);
          return true;
        }
        settled = true;
      }
      if (event === "close" && pendingClose > 0) { pendingClose--; return true; }
      if (settled && pendingClose === 0) server.emit = emit;
      return emit.call(this, event, ...rest);
    } as typeof server.emit;
    return listen.apply(this, args as never);
  };
  Object.defineProperty(patched, PATCHED, { value: true });
  net.Server.prototype.listen = patched as typeof listen;
}

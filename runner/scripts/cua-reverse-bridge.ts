import { setTimeout as delay } from 'node:timers/promises';
import { registration, serveConnection } from '../src/cua-reverse-bridge.ts';

const {endpoint,token,socketPath} = registration(process.env);
const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGTERM',stop);
process.once('SIGINT',stop);

async function run() {
  // Node 内置 WebSocket 的握手选项支持 Authorization。令牌只发给固定的 WSS 注册地址。
  const Socket = WebSocket as typeof import('undici-types').WebSocket;
  let retryMs = 1000;
  while (!controller.signal.aborted) {
    const socket = new Socket(endpoint,{headers:{Authorization:'Bearer ' + token}});
    const shutdown = serveConnection(socket as unknown as WebSocket,socketPath);
    let openedAt = 0;
    await new Promise<void>(resolve => {
      const finish = () => {
        clearTimeout(handshake);
        controller.signal.removeEventListener('abort',finish);
        socket.removeEventListener('error',finish);
        socket.removeEventListener('close',finish);
        if (socket.readyState < WebSocket.CLOSING) socket.close();
        resolve();
      };
      // 握手失败可能只产生 error；超时、退出和已建立连接断开都走同一条清理路径。
      const handshake = setTimeout(finish,10_000);
      socket.addEventListener('open',() => { clearTimeout(handshake); openedAt = Date.now(); },{once:true});
      socket.addEventListener('close',finish,{once:true});
      socket.addEventListener('error',finish,{once:true});
      controller.signal.addEventListener('abort',finish,{once:true});
    });
    await shutdown();
    if (controller.signal.aborted) return;
    if (openedAt && Date.now() - openedAt >= 30_000) retryMs = 1000;
    await delay(Math.floor(retryMs * (0.8 + Math.random() * 0.2)),undefined,{signal:controller.signal}).catch(() => {});
    retryMs = Math.min(30_000,retryMs * 2);
  }
}
void run().catch(() => { console.error('Cua 目录桥运行失败。'); process.exitCode = 1; });

import { AndroidRelay } from '../src/android-relay.ts';
import { readFileSync, accessSync, constants, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PairingSlots, pairingCaddy, startPairedRelays } from '../src/cua-pairing.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { registration, serveConnection } from '../src/cua-reverse-bridge.ts';

if (process.argv[2] === '--print-pair-caddy') {
  console.log(pairingCaddy(process.argv[3] ?? '',process.env.CUA_PAIR_CAPACITY));
  process.exit(0);
}
const {endpoint,token,socketPath} = registration(process.env);
const readyFile = process.env.RUNTIME_DIRECTORY && join(process.env.RUNTIME_DIRECTORY,'connected');
const controller = new AbortController();
let pairing: PairingSlots | undefined;
if (process.env.CUA_PAIR_RELAY_URL) {
  try {
    for (const binary of ['/usr/local/bin/cua','/usr/local/bin/cua-relay']) accessSync(binary,constants.X_OK);
    pairing = new PairingSlots('/var/lib/cs-agent-cua-pairing',process.env.CUA_PAIR_RELAY_URL,process.env.CUA_PAIR_CAPACITY);
    startPairedRelays(pairing,socketPath,controller.signal);
  } catch {
    pairing = undefined;
    console.error('Cua 管理台配对未启用，请核对本机组件、Relay 地址和状态目录。');
  }
}
const android = process.env.ANDROID_REGISTRY_FILE ? new AndroidRelay(JSON.parse(readFileSync(process.env.ANDROID_REGISTRY_FILE,'utf8'))) : undefined;
if (android) android.http.listen(18876,'127.0.0.1');
const stop = () => { controller.abort(); android?.close(); };
process.once('SIGTERM',stop);
process.once('SIGINT',stop);

async function run() {
  // Node 内置 WebSocket 的握手选项支持 Authorization。令牌只发给固定的 WSS 注册地址。
  const Socket = WebSocket as typeof import('undici-types').WebSocket;
  let retryMs = 1000;
  while (!controller.signal.aborted) {
    const socket = new Socket(endpoint,{headers:{Authorization:'Bearer ' + token}});
    const shutdown = serveConnection(socket as unknown as WebSocket,socketPath,pairing,android);
    let openedAt = 0;
    await new Promise<void>(resolve => {
      const finish = () => {
        clearTimeout(handshake);
        if (readyFile) rmSync(readyFile,{force:true});
        controller.signal.removeEventListener('abort',finish);
        socket.removeEventListener('error',finish);
        socket.removeEventListener('close',finish);
        if (socket.readyState < WebSocket.CLOSING) socket.close();
        resolve();
      };
      // 握手失败可能只产生 error；超时、退出和已建立连接断开都走同一条清理路径。
      const handshake = setTimeout(finish,10_000);
      socket.addEventListener('open',() => {
        clearTimeout(handshake);
        openedAt = Date.now();
        if (readyFile) writeFileSync(readyFile,String(process.pid),{mode:0o600});
      },{once:true});
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

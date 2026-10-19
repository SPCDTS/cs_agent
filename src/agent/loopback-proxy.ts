/**
 * 容器内 loopback TCP 转发：127.0.0.1:<port> → 远端 ComfyUI。
 *
 * 原因：comfy-cli 1.22 在 local 模式下拒绝从非 loopback 主机获取 /object_info（SSRF 防护），
 * 而 comfy-mcp 的 generate_image 走 `comfy run-template --param` 必须先取 object_info，
 * 因此直接把 COMFYUI_URL 指向 host.docker.internal 时生图必然失败。经 loopback 转发即可。
 */
import net from "node:net";
import { log } from "../shared/log.js";

export function isLoopbackUrl(url: string): boolean {
  const h = new URL(url).hostname;
  return h === "localhost" || h === "::1" || h === "[::1]" || /^127\./.test(h);
}

export interface LoopbackProxy {
  url: string;
  close(): Promise<void>;
}

export async function startLoopbackProxy(targetUrl: string, listenPort: number): Promise<LoopbackProxy> {
  const target = new URL(targetUrl);
  const targetPort = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, target.hostname);
    client.pipe(upstream).pipe(client);
    const done = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", done);
    upstream.on("error", (err) => {
      log.debug("comfy proxy upstream error", { error: err.message });
      done();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as net.AddressInfo).port;
  log.info("comfy loopback proxy listening", { listen: `127.0.0.1:${port}`, target: `${target.hostname}:${targetPort}` });
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

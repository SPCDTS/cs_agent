import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

/**
 * magpie 模型网关容器（docs/WORKERS-DESIGN.md §3.7），durable_object 调度策略：容器由本 DO 用
 * ctx.container.start() 按需拉起，镜像来自 wrangler.jsonc 的 images.magpie（magpie/Dockerfile）。
 * 容器里 3425 是 magpie 本身，3426 是回环中继：Worker 进来的源地址不是回环，magpie 会要求已启用的
 * 网关 key，而网关 key 不随 R2 同步、容器每次启动都是新的；中继把连接转到 127.0.0.1:3425，
 * magpie 便按回环处理，任意 Bearer 都接受。3430 是 Web UI，Worker 把 MAGPIE_WEB_HOST 上的请求转来；
 * 它来自非回环地址，magpie 要求 MAGPIE_WEB_KEY 登录。容器端口只有本 DO 能到达。
 */
export class MagpieContainer extends DurableObject<Env> {
  /** 空闲多久后让容器退出；下一次模型调用冷启动几秒并从 R2 取回状态 */
  private static readonly IDLE_MS = 30 * 60 * 1000;
  /** 冷启动等待：网关进程起来加 R2 首次同步，一般几秒，上限一分钟 */
  private static readonly START_ATTEMPTS = 120;
  private static readonly START_INTERVAL_MS = 500;

  private ensureStarted(): void {
    const container = this.ctx.container;
    if (!container) throw new Error("magpie container not configured");
    container.setInactivityTimeout(MagpieContainer.IDLE_MS);
    if (container.running) return;
    const env = this.env;
    container.start({
      image: container.images.magpie,
      enableInternet: true,
      instance: "lite",
      // R2 凭据与同步口令是 Worker 的 secrets，只在这里进容器环境，不进镜像、不进日志
      env: {
        R2_BUCKET: env.R2_BUCKET ?? "",
        R2_ENDPOINT: env.R2_ENDPOINT ?? "",
        R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID ?? "",
        R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY ?? "",
        MAGPIE_SYNC_PASSPHRASE: env.MAGPIE_SYNC_PASSPHRASE ?? "",
        MAGPIE_SYNC_MINUTES: "3",
        // magpie 自己读这两个变量，空值可能被当成非法配置，所以没配就不传
        ...(env.MAGPIE_WEB_KEY ? { MAGPIE_WEB_KEY: env.MAGPIE_WEB_KEY } : {}),
        ...(env.MAGPIE_WEB_HOST ? { MAGPIE_WEB_URL: `https://${env.MAGPIE_WEB_HOST}` } : {}),
      },
    });
    // 只记录退出，不阻塞请求；容器退出后下一次请求重新 start
    this.ctx.waitUntil(container.monitor().catch(error => {
      console.error({ event: "magpie_container_exit", message: error instanceof Error ? error.message : String(error) });
    }));
  }

  /**
   * 销毁容器，下一次请求用当时的 env 重新 start()。用于 secrets 变更后：容器是用启动那一刻的环境变量
   * 起来的，R2 凭据补上后，已经在跑的空配置 magpie 不会自己重来。
   */
  async restart(): Promise<void> {
    const container = this.ctx.container;
    if (container?.running) await container.destroy("restart requested");
  }

  /**
   * 把一个 HTTP 请求转给容器：主机名是 MAGPIE_WEB_HOST 的去 Web UI，其余去模型中继；start() 返回时进程
   * 未必就绪，连接失败按间隔重试。Web UI 的 WebSocket 也走这里而不是 RPC 方法：RPC 不能序列化
   * 带 WebSocket 的 Response。升级请求是没有 body 的 GET，带着 Upgrade 头转出去，端口返回的 101
   * 连同 webSocket 原样交回；响应体不缓冲，流式输出直接透传。
   */
  override async fetch(request: Request): Promise<Response> {
    this.ensureStarted();
    const incoming = new URL(request.url);
    const web = !!this.env.MAGPIE_WEB_HOST && incoming.hostname === this.env.MAGPIE_WEB_HOST;
    const port = this.ctx.container!.getTcpPort(web ? 3430 : 3426);
    const target = `http://container${incoming.pathname}${incoming.search}`;
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    let lastError: unknown;
    for (let attempt = 0; attempt < MagpieContainer.START_ATTEMPTS; attempt++) {
      try {
        return await port.fetch(target, { method: request.method, headers: request.headers, body });
      } catch (error) {
        lastError = error;
        await new Promise(resolve => setTimeout(resolve, MagpieContainer.START_INTERVAL_MS));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("magpie container unreachable");
  }
}

/** pi-ai 侧用这个主机名当 baseUrl；installMagpieRoute 把它改道到容器。 */
export const MAGPIE_CONTAINER_ORIGIN = "http://magpie.container";
export const MAGPIE_CONTAINER_BASE_URL = `${MAGPIE_CONTAINER_ORIGIN}/v1`;

let installed: Env | undefined;

/**
 * 把发往 magpie.container 的 fetch 改道到容器 DO。pi-ai 的 provider 走全局 fetch，
 * pi-durable 的生成任务不暴露按请求注入 fetch 的入口，所以在这一层包一次；
 * 其他主机名原样放行。多次调用只装一次，env 以最后一次为准。
 */
export function installMagpieRoute(env: Env): void {
  const first = installed === undefined;
  installed = env;
  if (!first) return;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(`${MAGPIE_CONTAINER_ORIGIN}/`)) return original(input, init);
    const current = installed!;
    if (!current.MAGPIE) throw new Error("magpie container binding missing");
    const request = input instanceof Request ? new Request(input, init) : new Request(url, init);
    return current.MAGPIE.getByName("gateway").fetch(request);
  }) as typeof fetch;
}

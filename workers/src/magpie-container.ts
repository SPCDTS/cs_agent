import { Container, getContainer } from "@cloudflare/containers";
import type { Env } from "./env";

/**
 * magpie 模型网关容器（docs/WORKERS-DESIGN.md §3.7）。镜像见 magpie/Dockerfile：
 * 容器里 3425 是 magpie 本身，3426 是回环中继。Worker 经 container binding 进来的源地址不是回环，
 * magpie 会要求已启用的网关 key，而网关 key 不随 R2 同步、容器每次启动都是新的；中继把连接转到
 * 127.0.0.1:3425，magpie 便按回环处理，任意 Bearer 都接受。容器端口只有绑定它的 Worker 能到达。
 */
export class MagpieContainer extends Container<Env> {
  defaultPort = 3426;
  // 空闲半小时后休眠；下一次模型调用冷启动几秒并从 R2 取回状态
  sleepAfter = "30m";

  constructor(ctx: ConstructorParameters<typeof Container<Env>>[0], env: Env) {
    super(ctx, env);
    // R2 凭据与同步口令是 Worker 的 secrets，只在这里进容器环境，不进镜像、不进日志
    this.envVars = {
      R2_BUCKET: env.R2_BUCKET ?? "",
      R2_ENDPOINT: env.R2_ENDPOINT ?? "",
      R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID ?? "",
      R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY ?? "",
      MAGPIE_SYNC_PASSPHRASE: env.MAGPIE_SYNC_PASSPHRASE ?? "",
      MAGPIE_SYNC_MINUTES: "3",
    };
  }
}

/** pi-ai 侧用这个主机名当 baseUrl；installMagpieRoute 把它改道到容器。 */
export const MAGPIE_CONTAINER_ORIGIN = "http://magpie.container";
export const MAGPIE_CONTAINER_BASE_URL = `${MAGPIE_CONTAINER_ORIGIN}/v1`;

let installed: Env | undefined;

/**
 * 把发往 magpie.container 的 fetch 改道到容器端口。pi-ai 的 provider 走全局 fetch，
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
    return getContainer(current.MAGPIE, "gateway").containerFetch(request, 3426);
  }) as typeof fetch;
}

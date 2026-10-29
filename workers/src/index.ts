import { timingSafeEqual } from "node:crypto";
import type { Env } from "./env";

export { BridgeDO } from "./bridge";
export { ThreadDO } from "./thread";
export { MagpieContainer } from "./magpie-container";

async function authenticated(request: Request, env: Env): Promise<boolean> {
  if (!env.NAPCAT_TOKEN) return false;
  const header = request.headers.get("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : new URL(request.url).searchParams.get("access_token");
  if (token === null) return false;
  // 固定长度摘要交给原生常量时间比较，避免逐字符比较泄露匹配前缀。
  const encode = new TextEncoder();
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encode.encode(token)),
    crypto.subtle.digest("SHA-256", encode.encode(env.NAPCAT_TOKEN)),
  ]);
  return timingSafeEqual(new Uint8Array(actual), new Uint8Array(expected));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/onebot") {
      if (!(await authenticated(request, env))) return new Response("unauthorized", { status: 401 });
      return env.BRIDGE.getByName("napcat").fetch(request);
    }
    if (request.method === "GET" && path === "/healthz") {
      const owner = env.THREAD.getByName("owner");
      const [bridge, model, thread] = await Promise.all([
        env.BRIDGE.getByName("napcat").status(), owner.modelStatus(), owner.stats(),
      ]);
      const ok = !("unavailable" in model);
      const { threads, sendRules, ...connection } = bridge;
      return Response.json({ ok, commit: env.CS_AGENT_COMMIT, bridge: connection, model, thread, threads, sendRules }, { status: ok ? 200 : 503 });
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

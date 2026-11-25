import { finishCuaSetup } from "../cua/setup";
import type { Env } from "../env";

export async function registerReverse(request: Request, env: Env, id: string, ctx?: ExecutionContext) {
  const denied = () => new Response("unauthorized", { status: 401 });
  const bearer = request.headers.get("Authorization") ?? "";
  if (new URL(request.url).search || !/^Bearer [A-Za-z0-9._~-]{32,256}$/.test(bearer)) return denied();
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("websocket required", { status: 426 });
  const registry = env.REGISTRY.getByName("main");
  const digest = await registry.mcpReverseRegistration(id, bearer).catch(() => null);
  if (!digest) return denied();
  // 轮换凭据后不再寻址旧实例。仅转发固定内部路径，不传递外部凭据或角色头。
  const response = await env.BRIDGE.getByName("mcp-reverse:" + digest).fetch("https://relay/register", { headers: { Upgrade: "websocket" } });
  if (id === "cua" && response.status === 101) ctx?.waitUntil(finishCuaSetup(env));
  return response;
}

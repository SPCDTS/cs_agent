import type { Env } from "../env";
import { authenticated } from "../auth";
import { FILE_MAX_BYTES } from "../../../runner/src/protocol";
const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
async function bytes(request: Request, limit: number): Promise<Uint8Array> {
  if (Number(request.headers.get("content-length") ?? 0) > limit) throw new Error("too_large");
  const reader = request.body?.getReader(); if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > limit) { await reader.cancel(); throw new Error("too_large"); } chunks.push(chunk.value); }
  const result = new Uint8Array(size); let at = 0; for (const chunk of chunks) { result.set(chunk, at); at += chunk.length; } return result;
}
async function body(request: Request, limit = 128 * 1024): Promise<unknown> { return JSON.parse(new TextDecoder().decode(await bytes(request, limit))); }
export async function remoteSandboxRoutes(request: Request, env: Env): Promise<Response | undefined> {
  const url = new URL(request.url), path = url.pathname;
  if (!path.startsWith("/sandbox-devices/") && !path.startsWith("/admin/sandbox-devices")) return;
  if (env.REMOTE_SANDBOX_ENABLED !== "true") return json({ error: "disabled" }, 404);
  const fleet = env.SANDBOX_FLEET.getByName("owner");
  try {
    if (path.startsWith("/admin/")) {
      if (!await authenticated(request, env.ADMIN_TOKEN)) return json({ error: "unauthorized" }, 401);
      if (path === "/admin/sandbox-devices" && request.method === "GET") return json(await fleet.devices());
      if (path === "/admin/sandbox-devices/pairings" && request.method === "POST") return json(await fleet.createPairing(), 201);
      const abandon = /^\/admin\/sandbox-devices\/jobs\/([a-f0-9-]{36})\/abandon$/.exec(path);
      if (abandon && request.method === "POST") {
        const input = await body(request);
        if (!input || typeof input !== "object" || !("acknowledgeUnknownExecution" in input) || input.acknowledgeUnknownExecution !== true) return json({ error: "unknown_execution_acknowledgement_required" }, 400);
        return json(await fleet.abandon(abandon[1]!));
      }
      const match = /^\/admin\/sandbox-devices\/([a-f0-9-]{36})(\/approve)?$/.exec(path);
      if (match && match[2] && request.method === "POST") { await fleet.approve(match[1]!); return json({ ok: true }); }
      if (match && !match[2] && request.method === "DELETE") { await fleet.revoke(match[1]!); return json({ ok: true }); }
    }
    if (path === "/sandbox-devices/claim" && request.method === "POST") return json(await fleet.claim(await body(request)));
    const match = /^\/sandbox-devices\/([a-f0-9-]{36})\/(connect|jobs\/([a-zA-Z0-9:_-]{1,160})(?:\/(input|result|objects\/([a-f0-9]{64})))?)$/.exec(path);
    if (!match) return json({ error: "not_found" }, 404);
    const deviceId = match[1]!;
    if (match[2] === "connect" && request.method === "GET") {
      url.searchParams.set("device", deviceId);
      return fleet.fetch(new Request(url, request));
    }
    if (!await fleet.authorize(deviceId, request.headers.get("Authorization"))) return json({ error: "unauthorized" }, 401);
    const jobId = match[3]!, action = match[4];
    if (action === "input" && request.method === "GET") return json(await fleet.input(deviceId, jobId));
    if (action?.startsWith("objects/") && request.method === "GET") return new Response(await fleet.inputBlob(deviceId, jobId, match[5]!), { headers });
    if (action?.startsWith("objects/") && request.method === "PUT") { await fleet.upload(deviceId, jobId, match[5]!, await bytes(request, FILE_MAX_BYTES)); return json({ ok: true }); }
    if (action === "result" && request.method === "POST") { await fleet.complete(deviceId, jobId, await body(request, 8 * 1024 * 1024)); return json({ ok: true }); }
    return json({ error: "not_found" }, 404);
  } catch (error) {
    const code = error instanceof Error ? error.message : "invalid_request";
    console.error({ event: "remote_sandbox_request_failed", code: code.slice(0, 180) });
    return json({ error: code.slice(0, 180) }, code.includes("denied") ? 403 : code === "too_large" ? 413 : 400);
  }
}

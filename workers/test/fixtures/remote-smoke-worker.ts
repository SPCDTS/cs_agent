import { readCatalog, readJob } from "../../src/remote-sandbox/wire";
import type { Env } from "../../src/env";
import { remoteSandboxRoutes } from "../../src/remote-sandbox/routes";
import { authenticated } from "../../src/auth";
export { SandboxDO } from "../../src/sandbox/do";
export { SandboxFleetDO } from "../../src/remote-sandbox/fleet";
/** 仅供本机 smoke 使用，生产入口不导入此文件。 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const routed = await remoteSandboxRoutes(request, env); if (routed) return routed;
    if (!await authenticated(request, env.ADMIN_TOKEN)) return new Response("unauthorized", { status: 401 });
    const url = new URL(request.url), workspace = "smoke:" + (url.searchParams.get("run") ?? "default"), fleet = env.SANDBOX_FLEET.getByName("owner");
    if (url.pathname === "/smoke/start") {
      const devices = readCatalog(await fleet.catalogJson({ os: "windows", tools: ["powershell"] }));
      const selected = devices.find(device => device.provider === "windows-wsb" && device.availability === "ready");
      if (!selected) return Response.json({ ready: false });
      const lease = await fleet.acquire({ sandboxId: selected.id, workspace, capabilityRevision: selected.capabilityRevision, requirements: { os: "windows" }, operationId: "smoke-lease" });
      const started = await fleet.invoke(workspace, "smoke-first", { leaseId: lease.id, tool: "powershell", timeoutMs: 30000,
        arguments: { command: "New-Item -ItemType Directory -Force .git,node_modules | Out-Null; Set-Content -LiteralPath result.txt -Encoding UTF8 -Value 'guest persistence verified'; Write-Output first" } });
      return Response.json({ ...started, leaseId: lease.id });
    }
    if (url.pathname === "/smoke/status") {
      return Response.json(readJob(await fleet.inspectJson(workspace, url.searchParams.get("id") ?? "")));
    }
    if (url.pathname === "/smoke/next") return Response.json(await fleet.invoke(workspace, "smoke-second", {
      leaseId: url.searchParams.get("lease") ?? "", tool: "powershell", timeoutMs: 30000,
      arguments: { command: "if (!(Test-Path .git) -or !(Test-Path node_modules)) { exit 9 }; Get-Content -LiteralPath result.txt -Encoding UTF8" },
    }));
    if (url.pathname === "/smoke/release") { await fleet.release(workspace, url.searchParams.get("lease") ?? ""); return Response.json({ release: "requested" }); }
    return new Response("not found", { status: 404 });
  },
};

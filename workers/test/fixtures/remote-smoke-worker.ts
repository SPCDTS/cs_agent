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
    const url = new URL(request.url), sandbox = env.SANDBOX.getByName("smoke:" + (url.searchParams.get("run") ?? "default"));
    if (url.pathname === "/smoke/start") {
      const devices = await env.SANDBOX_FLEET.getByName("owner").catalog("shell.exec", { os: "windows" });
      const selected = devices.find(device => device.provider === "windows-wsb" && device.availability === "ready");
      if (!selected) return Response.json({ ready: false });
      await sandbox.acquireSandbox({ sandboxId: selected.id, capabilityRevision: selected.capabilityRevision, taskType: "shell.exec", requirements: { os: "windows" }, operationId: "smoke-lease" });
      await sandbox.writeFile("probe.mjs", "import fs from 'node:fs'; fs.writeFileSync('result.txt','Worker 到 WSB 再回 R2'); console.log('真实链路完成');", "smoke-source");
      return Response.json(await sandbox.startRemoteJob("smoke-job", { kind: "shell.exec", shell: "powershell", command: "node probe.mjs", cwd: "/work", timeoutMs: 30000 }));
    }
    if (url.pathname === "/smoke/status") {
      const status = await sandbox.finishRemoteJob(url.searchParams.get("id") ?? "");
      return Response.json({ status, files: await sandbox.files(), selection: await sandbox.sandboxSelection() });
    }
    if (url.pathname === "/smoke/result") return new Response((await sandbox.readBlob("result.txt")).bytes);
    if (url.pathname === "/smoke/release") return Response.json(await sandbox.releaseSandbox());
    return new Response("not found", { status: 404 });
  },
};

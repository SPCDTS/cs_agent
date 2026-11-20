import type { Env } from "../env";
import { viewName } from "../requests/projection";
import { subagentName } from "../subagent/model";
import { createWorkspaceAdminApi } from "../sandbox/admin";
export const threadView = (env: Env, thread: string) => env.REQUESTS.getByName(viewName("thread:" + thread));
export function workspaceView(env: Env, thread: string) {
  return createWorkspaceAdminApi({ authorize: async () => {}, current: () => env.SANDBOX.getByName(thread), child: async id => {
    const child = await threadView(env, thread).workspaceChild(thread, id);
    const resource = child.sandboxId === undefined ? undefined : await env.CLOUDFLARE_WORKSPACE_RESOURCES.getByName("owner").get(thread, child.sandboxId);
    if (child.sandboxId !== undefined && !resource) throw new Error("workspace_denied");
    const sourceName = resource?.name ?? subagentName(thread, id);
    return { sourceName, sandbox: env.SANDBOX.getByName(sourceName) };
  } });
}

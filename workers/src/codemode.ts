import type { Context } from "@earendil-works/chord/context";
import { defineExtension, type Registry, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { createCodemodeExtension, type CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import { createInlineCodemodeSandbox } from "@earendil-works/pi-codemode/cloudflare";

/** 每个 Harness 共用一个脚本运行时；业务权限仍由每个 nested 工具复核。 */
export function installCodemode(registry: Registry, options: {
  allowed(api: ToolExecutionApi, context: Context): Promise<boolean>;
  namespaces?(): readonly CodemodeNamespace[];
}) {
  const sandbox = createInlineCodemodeSandbox();
  const extension = () => createCodemodeExtension({ sandbox, models: false, namespaces: [
    { name: "workspace-skills", prefix: "skill_", description: "Cloudflare 工作区技能检查与发布" },
    ...options.namespaces?.() ?? [],
  ] });
  const base = extension();
  registry.install(defineExtension({ ...base, name: "cs.codemode",
    tools: (base.tools ?? []).map(tool => ({ ...tool, execute: async (args, api, context) => {
      if (!await options.allowed(api, context)) return { isError: true, output: [{ type: "text" as const, text: "denied" }] };
      const current = extension().tools?.find(candidate => candidate.name === tool.name);
      if (!current) throw new Error("codemode_unavailable");
      return current.execute(args, api, context);
    } })),
    sections: (base.sections ?? []).map(part => ({ ...part, render: (input, context) =>
      extension().sections?.find(candidate => candidate.key === part.key)?.render(input, context) })),
  }));
  return { close: () => sandbox.close() };
}

import type { Context } from "@earendil-works/chord/context";
import { defineExtension, type Registry, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { createInlineCodemodeSandbox } from "@earendil-works/pi-codemode/cloudflare";

/** 每个 Harness 共用一个脚本运行时；业务权限仍由每个 nested 工具复核。 */
export function installCodemode(registry: Registry, options: {
  allowed(api: ToolExecutionApi, context: Context): Promise<boolean>;
}) {
  const sandbox = createInlineCodemodeSandbox();
  const base = createCodemodeExtension({ sandbox, models: false });
  registry.install(defineExtension({ ...base, name: "cs.codemode",
    tools: (base.tools ?? []).map(tool => ({ ...tool, execute: async (args, api, context) => {
      if (!await options.allowed(api, context)) return { isError: true, output: [{ type: "text" as const, text: "denied" }] };
      return tool.execute(args, api, context);
    } })),
  }));
  return { close: () => sandbox.close() };
}

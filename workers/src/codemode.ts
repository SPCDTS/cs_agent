import type { Context } from "@earendil-works/chord/context";
import { defineDoc, defineExtension, LiveDoc, type Agent, type Harness, type JsonObject, type NestedToolCall, type NestedToolExecutionResult, type Registry, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { createInlineCodemodeSandbox } from "@earendil-works/pi-codemode/cloudflare";
import { deviceToolAlias } from "./mcp/device-tools";

/** 一轮模型请求拥有其全部工具任务。任务退役时，这份别名到原契约的绑定随之回收。 */
const DeviceBindings = defineDoc<{ names: Record<string, string> }>({
  kind: "cs.codemode.device-bindings", version: 1, scope: "task", initial: () => ({ names: {} }),
  checkpointWhen: () => false,
});

function deviceBindings(agent: Agent) {
  const used = new Set(agent.callable.map(tool => tool.name));
  const names: Record<string, string> = {};
  for (const tool of agent.callable) {
    const alias = deviceToolAlias in tool ? tool[deviceToolAlias] : undefined;
    if (typeof alias !== "string") continue;
    let name = alias;
    for (let i = 2; used.has(name); i++) name = alias + "_" + i;
    used.add(name);
    names[name] = tool.name;
  }
  return names;
}

/** Code Mode 用 callable 生成声明，用 extensions 确定搜索分组，两处须使用同一名称。 */
function present(agent: Agent, names: Record<string, string>): Agent {
  const byNative = new Map(Object.entries(names).map(([alias, native]) => [native, alias]));
  if (!byNative.size) return agent;
  const rename = (tool: ToolRegistration) => {
    const name = byNative.get(tool.name);
    return name ? { ...tool, name } : tool;
  };
  return { ...agent, callable: agent.callable.filter(tool => !(deviceToolAlias in tool) || byNative.has(tool.name)).map(rename), extensions: agent.extensions.map(ext =>
    ext.tools?.some(tool => byNative.has(tool.name)) ? { ...ext, tools: ext.tools.map(rename) } : ext) };
}

/** executeTool 的两个重载分别返回结果和任务句柄，保留调用方选择的等待方式。 */
function bindCalls(api: ToolExecutionApi, names: Record<string, string>): ToolExecutionApi["executeTool"] {
  type Options = { key?: string; progress?: boolean };
  function call(name: string, input: JsonObject, c: Context, opts?: Options & { wait?: true }): Promise<NestedToolExecutionResult>;
  function call(name: string, input: JsonObject, c: Context, opts: Options & { wait: false }): Promise<NestedToolCall>;
  function call(name: string, input: JsonObject, c: Context, opts?: Options & { wait?: boolean }) {
    const target = Object.hasOwn(names, name) ? names[name]! : name;
    return opts?.wait === false ? api.executeTool(target, input, c, { ...opts, wait: false })
      : api.executeTool(target, input, c, { ...opts, wait: true });
  }
  return call;
}

export function installCodemode(registry: Registry, options: {
  /** 子 agent 的目录由派出快照固定；主会话按每轮生成任务保存。 */
  catalog: "delegated-snapshot" | (() => Harness);
  allowed(api: ToolExecutionApi, context: Context): Promise<boolean>;
}) {
  const sandbox = createInlineCodemodeSandbox();
  const base = createCodemodeExtension({ sandbox, models: false });
  registry.install(defineExtension({ ...base, name: "cs.codemode",
    sections: base.sections?.map(section => ({ ...section, async render(input, context) {
      const names = deviceBindings(input.agent);
      if (options.catalog !== "delegated-snapshot" && Object.keys(names).length) {
        const run = (await input.read.snapshot(LiveDoc, input.conversationId, context))?.run;
        if (!run) throw new Error("device_tool_generation_missing");
        await options.catalog().commit(async tx => { (await tx.doc(DeviceBindings, run.taskId)).names = names; }, context);
      }
      return section.render({ ...input, agent: present(input.agent, names) }, context);
    } })),
    tools: (base.tools ?? []).map(tool => ({ ...tool, execute: async (args, api, context) => {
      if (!await options.allowed(api, context)) return { isError: true, output: [{ type: "text" as const, text: "denied" }] };
      const agent = await api.agent(context);
      let names: Record<string, string> | undefined;
      if (options.catalog === "delegated-snapshot") names = deviceBindings(agent);
      else {
        const task = await api.getTask(api.taskId, context);
        if (task?.owner) names = (await api.snapshot(DeviceBindings, task.owner, context))?.names;
      }
      // 升级前的请求和没有设备的请求继续使用原来的工具名。
      if (!names || !Object.keys(names).length) return tool.execute(args, api, context);
      const visible = present(agent, names);
      return tool.execute(args, { ...api,
        agent: async () => visible,
        executeTool: bindCalls(api, names),
      }, context);
    } })),
  }));
  return { close: () => sandbox.close() };
}

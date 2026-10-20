import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { SCHEDULE_MANAGEMENT_TOOLS, type ScheduleTool } from "../../shared/schedule-tools.js";
import { scheduleDescriptions, scheduleParameters } from "../schedule/tool-schema.js";
import type { ScheduleTools } from "../schedule/tools.js";
import { PiRequestDoc } from "./request.js";

/** 固定注册、逐轮选择；恢复与调用时仍通过持久票据重新授权。 */
export function createPiScheduleExtensions(service?: ScheduleTools) {
  const make = (name: string, names: readonly ScheduleTool[]) => defineExtension({
    name,
    tools: names.map(name => defineTool({
      name, description: scheduleDescriptions[name], parameters: scheduleParameters[name],
      replay: name === "schedule_list" ? "safe" as const : "unsafe" as const,
      async execute(args, api, context) {
        const output = (text: string) => ({ output: [{ type: "text" as const, text }] });
        try {
          const bound = await api.snapshot(PiRequestDoc, api.conversationId, context);
          if (!bound?.ticket || !service) throw new Error("定时工具缺少本回合绑定");
          if (bound.deadline <= Date.now()) throw new Error("pi 请求已超时");
          context.abortSignal?.throwIfAborted();
          return output(await service.tool(bound, name, args));
        } catch (error) { return { ...output((error as Error).message), isError: true }; }
      },
    })),
  });
  return { management: make("cs-pi-schedule", SCHEDULE_MANAGEMENT_TOOLS), control: make("cs-pi-schedule-control", ["schedule_control"]) };
}

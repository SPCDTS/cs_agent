import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { SCHEDULE_MANAGEMENT_TOOLS, type ScheduleTool } from "../../shared/schedule-tools.js";
import { parseScheduleCall, scheduleDescriptions, scheduleParameters } from "../schedule/tool-schema.js";
import type { ScheduleTools } from "../schedule/tools.js";
import type { PiCallBinding } from "./request.js";

/** 固定注册、逐轮选择；调用时仍按会话宿主的本轮身份重新授权（唤醒回合与子 agent 一律拒绝）。 */
export function createPiScheduleExtensions(binding: (conversationId: number) => Promise<PiCallBinding | undefined>, service?: ScheduleTools) {
  const make = (name: string, names: readonly ScheduleTool[]) => defineExtension({
    name,
    tools: names.map(name => defineTool({
      name, description: scheduleDescriptions[name], parameters: scheduleParameters[name],
      replay: "unsafe",
      async execute(args, api, context) {
        const output = (text: string) => ({ output: [{ type: "text" as const, text }] });
        try {
          const bound = await binding(Number(api.conversationId));
          if (!bound || !service) throw new Error("定时工具缺少本回合绑定");
          if (bound.child) throw new Error("子 agent 不能使用定时工具");
          context.abortSignal?.throwIfAborted();
          const call = parseScheduleCall(name, args);
          return output(await service.tool(bound, call.name, call.args));
        } catch (error) { return { ...output((error as Error).message), isError: true }; }
      },
    })),
  });
  return { management: make("cs-pi-schedule", SCHEDULE_MANAGEMENT_TOOLS), control: make("cs-pi-schedule-control", ["schedule_control"]) };
}

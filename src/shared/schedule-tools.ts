/** 两后端与回环服务共用的工具名称；权限由主进程根据会话当前回合的身份判断。 */
export const SCHEDULE_ACTIONS = ["create", "list", "update", "pause", "resume", "delete", "run_now"] as const;
export const SCHEDULE_MANAGEMENT_TOOLS = ["schedule"] as const;
export const SCHEDULE_OPERATIONS = [
  "schedule_create", "schedule_list", "schedule_update", "schedule_pause",
  "schedule_resume", "schedule_delete", "schedule_run_now", "schedule_control",
] as const;
export const SCHEDULE_TOOLS = [...SCHEDULE_MANAGEMENT_TOOLS, "schedule_control"] as const;
export type ScheduleTool = typeof SCHEDULE_TOOLS[number];
export interface ScheduleToolPermissions { schedule: boolean; scheduleControl: boolean }
export function isScheduleTool(name: string): name is ScheduleTool {
  return (SCHEDULE_TOOLS as readonly string[]).includes(name);
}

export type ScheduleOperation = typeof SCHEDULE_OPERATIONS[number];
export function isScheduleOperation(name: string): name is ScheduleOperation {
  return (SCHEDULE_OPERATIONS as readonly string[]).includes(name);
}

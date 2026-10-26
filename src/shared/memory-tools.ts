/** 两后端与回环服务共用的记忆工具名称（docs/MEMORY-DESIGN.md §6）；权限由主进程按会话当前回合的身份判断。 */
export const MEMORY_READ_TOOLS = ["mem_search", "mem_list"] as const;
export const MEMORY_WRITE_TOOLS = ["mem_remember", "mem_update", "mem_forget"] as const;
export const MEMORY_TOOLS = [...MEMORY_READ_TOOLS, ...MEMORY_WRITE_TOOLS, "mem_profile"] as const;
export type MemoryTool = typeof MEMORY_TOOLS[number];
export function isMemoryTool(name: string): name is MemoryTool {
  return (MEMORY_TOOLS as readonly string[]).includes(name);
}

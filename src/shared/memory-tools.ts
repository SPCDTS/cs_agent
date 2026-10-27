/** 两后端与回环服务共用的记忆工具名称（docs/MEMORY-DESIGN.md §6）；权限由主进程按会话当前回合的身份判断。 */
export const MEMORY_READ_TOOLS = ["mem_search"] as const;
export const MEMORY_WRITE_TOOLS = ["mem_remember", "mem_update", "mem_forget"] as const;
export const MEMORY_TOOLS = [...MEMORY_READ_TOOLS, ...MEMORY_WRITE_TOOLS, "mem_profile"] as const;
export type MemoryTool = typeof MEMORY_TOOLS[number];
export function isMemoryTool(name: string): name is MemoryTool {
  return (MEMORY_TOOLS as readonly string[]).includes(name);
}

/** 保留内部列表操作，模型通过不带 query 的 mem_search 调用。 */
export const MEMORY_OPERATIONS = [...MEMORY_TOOLS, "mem_list"] as const;
export type MemoryOperation = typeof MEMORY_OPERATIONS[number];
export function isMemoryOperation(name: string): name is MemoryOperation {
  return (MEMORY_OPERATIONS as readonly string[]).includes(name);
}

import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { MEMORY_READ_TOOLS, MEMORY_WRITE_TOOLS, memoryDescriptions, memoryParameters, parseMemoryCall, type MemoryTool } from "../memory/tools.js";
import type { MemoryAccess, MemoryService } from "../memory/service.js";
import type { PiCallBinding } from "./request.js";

const output = (text: string) => ({ output: [{ type: "text" as const, text }] });

/**
 * mem_* 工具（docs/MEMORY-DESIGN.md §5、§6）：读工具一个扩展、写工具两档（有无 mem_profile），固定注册、逐轮选择；
 * 调用时仍按会话宿主的本轮绑定由 MemoryService 重新求权限（子 agent 只读、未确证的人不可写）。
 */
export function createPiMemoryExtensions(binding: (conversationId: number) => Promise<PiCallBinding | undefined>, service?: MemoryService) {
  const make = (name: string, names: readonly MemoryTool[]) => defineExtension({
    name,
    tools: names.map(tool => defineTool({
      name: tool, description: memoryDescriptions[tool], parameters: memoryParameters[tool],
      replay: (MEMORY_READ_TOOLS as readonly string[]).includes(tool) ? "safe" as const : "unsafe" as const,
      async execute(args, api, context) {
        try {
          const bound = await binding(Number(api.conversationId));
          if (!bound || !service) throw new Error("记忆工具缺少本轮绑定");
          context.abortSignal?.throwIfAborted();
          const call = parseMemoryCall(tool, args);
          return output(await service.tool({ ...bound, backend: "pi", session: String(api.conversationId) }, call.name, call.args));
        } catch (error) { return { ...output((error as Error).message), isError: true }; }
      },
    })),
  });
  return {
    read: make("cs-pi-memory", MEMORY_READ_TOOLS),
    write: make("cs-pi-memory-write", MEMORY_WRITE_TOOLS),
    owner: make("cs-pi-memory-owner", [...MEMORY_WRITE_TOOLS, "mem_profile"]),
  };
}

export type PiMemoryExtensions = ReturnType<typeof createPiMemoryExtensions>;

/** 本轮该启用的写扩展：有画像权限用 owner 档，有可写命名空间用 write 档，否则没有写工具。 */
export function selectMemoryWriteExtension(extensions: PiMemoryExtensions, access: MemoryAccess) {
  return access.profile ? extensions.owner : access.write.length ? extensions.write : undefined;
}

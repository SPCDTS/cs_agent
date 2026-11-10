import { randomUUID } from "node:crypto";
import { PowerShellInputSchema, validateDescriptor, type JobInput, type Lease } from "../src/protocol.ts";
import { sha256 } from "../src/files.ts";
import type { Config } from "../src/wsb.ts";

export const capabilities = validateDescriptor({ name: "测试设备", provider: "windows-wsb", os: "windows", arch: "x64",
  instructions: "使用 powershell 在 guest 内运行命令。", persistence: "文件保留到租约释放。",
  resourceLifecycle: { create: "创建空工作区", clone: "复制来源文件" },
  tools: [{ name: "powershell", description: "执行 PowerShell", inputSchema: PowerShellInputSchema }],
  environment: [{ name: "node", version: "v24" }], memoryMiB: 4096, maxConcurrent: 1, maxTimeoutMs: 1200000, workspaceProtocol: "registered-tools-v2" });
export function lease(): Lease { const deviceId = randomUUID(); return { id: randomUUID(), deviceId, sandboxId: "remote:" + deviceId, workspace: "owner", operationId: randomUUID(), capabilityRevision: sha256(JSON.stringify(capabilities)), requirements: {}, createdAt: Date.now() }; }
export function job(binding = lease(), command = "probe"): JobInput { return { id: randomUUID(), lease: binding, tool: "powershell", arguments: { command }, timeoutMs: 1000, createdAt: Date.now(), deadline: Date.now() + 20000 }; }
export function config(deviceId: string, origin = "http://localhost:8787"): Config { return { origin, deviceId, tokenProtected: "test-only", name: "test", nodeDir: "C:\\Node", memoryMiB: 4096, maxTimeoutMs: 1200000 }; }

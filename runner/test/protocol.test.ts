import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDescriptor, validateToolArguments, validateOutcome, mismatch, parseFrame, DeviceFrameSchema, ServerFrameSchema, MAX_CONTROL_BYTES } from "../src/protocol.ts";
import { capabilities } from "./fixtures.ts";

test("设备注册的是可执行工具；环境版本不参与工具授权", () => {
  assert.deepEqual(mismatch(capabilities, { os: "windows", memoryMiB: 4096, tools: ["powershell"] }), []);
  assert.deepEqual(mismatch(capabilities, { os: "linux", memoryMiB: 8192, tools: ["node"] }), ["os", "memory", "tool:node"]);
  assert.deepEqual(validateToolArguments(capabilities, "powershell", { command: "Get-ChildItem" }), { command: "Get-ChildItem" });
  assert.throws(() => validateToolArguments(capabilities, "node", {}), /tool_not_registered/);
  assert.throws(() => validateToolArguments(capabilities, "powershell", { command: 42 }), /invalid_tool_arguments/);
  assert.throws(() => validateToolArguments(capabilities, "powershell", { command: "x", secret: "bad" }), /invalid_tool_arguments/);
});
test("注册 schema 拒绝外部引用、正则、深层结构与重复工具", () => {
  const schema = (inputSchema: object) => ({ ...capabilities, tools: [{ name: "powershell", description: "测试", inputSchema }] });
  assert.throws(() => validateDescriptor(schema({ type: "object", additionalProperties: false, $ref: "https://evil/schema" })), /unsupported_tool_schema/);
  assert.throws(() => validateDescriptor(schema({ type: "object", additionalProperties: false, properties: { command: { type: "string", pattern: "(a+)+$" } } })), /unsupported_tool_schema/);
  assert.throws(() => validateDescriptor({ ...capabilities, tools: [...capabilities.tools, ...capabilities.tools] }), /duplicate_tool/);
  let nested: object = { type: "string" };
  for (let i = 0; i < 8; i++) nested = { type: "array", items: nested };
  assert.throws(() => validateDescriptor(schema({ type: "object", additionalProperties: false, properties: { nested } })), /too_deep/);
  assert.throws(() => validateDescriptor(schema({ type: "object", additionalProperties: true })), /invalid_tool_schema/);
});
test("v1 被明确拒绝；控制消息与 JSON 结果有界", () => {
  assert.throws(() => parseFrame(DeviceFrameSchema, JSON.stringify({ kind: "hello", protocolVersion: 1, descriptor: capabilities })), /invalid_request/);
  assert.throws(() => validateDescriptor({ ...capabilities, workspaceProtocol: "r2-source-v1" }), /invalid_request/);
  assert.throws(() => parseFrame(ServerFrameSchema, JSON.stringify({ kind: "execute", jobId: "../x" })), /invalid_request/);
  assert.throws(() => parseFrame(ServerFrameSchema, " ".repeat(MAX_CONTROL_BYTES + 1)), /frame_too_large/);
  assert.deepEqual(validateOutcome({ kind: "completed", result: ["json", 1, true, null, { x: [] }] }), { kind: "completed", result: ["json", 1, true, null, { x: [] }] });
  assert.throws(() => validateOutcome({ kind: "completed", result: undefined }), /invalid_json/);
  assert.throws(() => validateOutcome({ kind: "completed", result: { x: Number.NaN } }), /invalid_json/);
  assert.throws(() => validateOutcome({ kind: "completed", result: "x".repeat(MAX_CONTROL_BYTES) }), /json_too_large/);
});

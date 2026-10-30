import { describe, expect, it } from "vitest";
import { canWriteMemory, type MemoryBinding } from "../src/memory/tools";

const member: MemoryBinding = { ns: "group:200000001", owner: false, userId: "10000003", turnId: "turn:synthetic",
  scope: "group:200000001", messageId: "1", origin: "message" };
describe("memory write authorization", () => {
  it("allows verified members to write their thread and limits profiles to the owner", () => {
    expect(canWriteMemory(member)).toBe(true);
    expect(canWriteMemory(member, true)).toBe(false);
    expect(canWriteMemory({ ...member, owner: true }, true)).toBe(true);
    expect(canWriteMemory({ ...member, ns: "private:10000003", scope: "private:10000003" })).toBe(true);
    expect(canWriteMemory({ ...member, ns: "private:10000004", scope: "private:10000004" })).toBe(false);
    expect(canWriteMemory({ ...member, scope: "group:200000002" })).toBe(false);
    expect(canWriteMemory({ ...member, ns: "owner" })).toBe(false);
  });
  it("treats events, child reports and missing origins as read-only even when they carry owner identity", () => {
    for (const origin of ["event", "subagent"] as const) {
      expect(canWriteMemory({ ...member, owner: true, origin })).toBe(false);
      expect(canWriteMemory({ ...member, owner: true, origin }, true)).toBe(false);
    }
    expect(canWriteMemory(JSON.parse(JSON.stringify({ ...member, origin: undefined })))).toBe(false);
    expect(canWriteMemory({ ...member, origin: "schedule" })).toBe(true);
  });
  it("accepts trusted web administration only in its bound scope", () => {
    expect(canWriteMemory({ ...member, origin: "web", userId: "admin:web" })).toBe(true);
    expect(canWriteMemory({ ...member, origin: "web", ns: "private:10000004", scope: "private:10000004", userId: "admin:web" })).toBe(true);
    expect(canWriteMemory({ ...member, origin: "web", scope: "group:200000002" })).toBe(false);
  });
});

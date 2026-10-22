import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ensureAgentPrompt, systemPromptFile, warnDeprecatedSystemPrompt } from "../../src/agent/prompt.js";
import { tmp } from "./helpers.js";

describe("deprecated system.md", () => {
  it("logs one deprecation line when the file exists and never deletes or rewrites it", () => {
    const dir = tmp();
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(warnDeprecatedSystemPrompt(dir)).toBe(false);
      mkdirSync(path.join(dir, "prompts"));
      writeFileSync(systemPromptFile(dir), "old prompt");
      expect(warnDeprecatedSystemPrompt(dir)).toBe(true);
      const lines = err.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("deprecated"));
      expect(lines).toHaveLength(1);
      expect(readFileSync(systemPromptFile(dir), "utf8")).toBe("old prompt");
    } finally {
      err.mockRestore();
    }
  });
});

it("seeds agent.md once without rewriting existing Chinese BOM/CRLF", async () => {
  const dir = tmp();
  await ensureAgentPrompt(dir);
  const file = path.join(dir, "prompts", "agent.md");
  expect(readFileSync(file, "utf8")).toContain("qq_image(message_id)");
  const original = Buffer.from("\ufeff自定义中文提示词\r\n", "utf8");
  writeFileSync(file, original);
  await ensureAgentPrompt(dir);
  expect(readFileSync(file)).toEqual(original);
});

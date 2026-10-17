import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "../../src/agent/extension.js";
import { ensureDefaultSystemPrompt, loadSystemPrompt, systemPromptFile } from "../../src/agent/prompt.js";
import { tmp } from "./helpers.js";

function writePrompt(dataDir: string, text: string, mtimeSec?: number) {
  const file = systemPromptFile(dataDir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  if (mtimeSec !== undefined) utimesSync(file, mtimeSec, mtimeSec);
  return file;
}

describe("loadSystemPrompt", () => {
  it("falls back to the built-in prompt when the file is missing", () => {
    expect(loadSystemPrompt(tmp())).toBe(SYSTEM_PROMPT);
  });

  it("uses the file content when present", () => {
    const dir = tmp();
    writePrompt(dir, "自定义提示 v1");
    expect(loadSystemPrompt(dir)).toBe("自定义提示 v1");
  });

  it("picks up a change on disk on the next call (same size, newer mtime)", () => {
    const dir = tmp();
    writePrompt(dir, "version-A", 1_700_000_000);
    expect(loadSystemPrompt(dir)).toBe("version-A");
    expect(loadSystemPrompt(dir)).toBe("version-A"); // 缓存命中
    writePrompt(dir, "version-B", 1_700_000_100);
    expect(loadSystemPrompt(dir)).toBe("version-B");
  });

  it("falls back when the file is empty/whitespace, and again after deletion", () => {
    const dir = tmp();
    const file = writePrompt(dir, "  \n\t\n");
    expect(loadSystemPrompt(dir)).toBe(SYSTEM_PROMPT);
    writePrompt(dir, "非空", 1_700_000_200);
    expect(loadSystemPrompt(dir)).toBe("非空");
    rmSync(file);
    expect(loadSystemPrompt(dir)).toBe(SYSTEM_PROMPT);
  });

  it("falls back (never throws) when the path is unreadable as a file", () => {
    const dir = tmp();
    mkdirSync(systemPromptFile(dir), { recursive: true }); // 目录而非文件
    expect(loadSystemPrompt(dir)).toBe(SYSTEM_PROMPT);
  });
});

describe("ensureDefaultSystemPrompt", () => {
  it("writes the built-in prompt once and never overwrites edits", async () => {
    const dir = tmp();
    expect(await ensureDefaultSystemPrompt(dir)).toBe(true);
    const file = systemPromptFile(dir);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8").trim()).toBe(SYSTEM_PROMPT.trim());
    expect(loadSystemPrompt(dir).trim()).toBe(SYSTEM_PROMPT.trim());
    writeFileSync(file, "edited");
    expect(await ensureDefaultSystemPrompt(dir)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("edited");
  });
});

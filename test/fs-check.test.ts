import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findUnwritable, probeWritable } from "../src/fs-check.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fs-check-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("writability probe", () => {
  it("writable dir passes and leaves no probe file behind", async () => {
    expect(await probeWritable(dir)).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("creates a missing dir", async () => {
    expect(await probeWritable(path.join(dir, "a", "b"))).toBeNull();
  });

  it("reports a dir that cannot be created/written", async () => {
    const file = path.join(dir, "not-a-dir");
    writeFileSync(file, "x");
    const bad = path.join(file, "sub");
    const result = await findUnwritable([dir, bad]);
    expect(result).toHaveLength(1);
    expect(result[0]!.dir).toBe(bad);
    expect(result[0]!.reason).toMatch(/E[A-Z]+/);
  });

});

import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateReferences } from "../../src/media/references.js";
import { tmp } from "../agent/helpers.js";
import { PNG_1PX as PNG } from "../agent/helpers.js";

describe("入站参考图范围", () => {
  it("允许列表、票据根目录与魔数同时校验；软链接不能逃逸", async () => {
    const base = tmp(); const root = path.join(base, "incoming", "a"); const other = path.join(base, "incoming", "b");
    await fs.mkdir(root, { recursive: true }); await fs.mkdir(other);
    const file = path.join(root, "1.png"); const outside = path.join(other, "2.png");
    await fs.writeFile(file, PNG); await fs.writeFile(outside, PNG);
    expect(await validateReferences([file], [file], root)).toEqual([await fs.realpath(file)]);
    await expect(validateReferences([file], [], root)).rejects.toThrow(/允许列表/);
    await expect(validateReferences([outside], [outside], root)).rejects.toThrow(/目录/);
    const link = path.join(root, "escape");
    await fs.symlink(other, link, process.platform === "win32" ? "junction" : "dir");
    const escape = path.join(link, "2.png");
    await expect(validateReferences([escape], [escape], root)).rejects.toThrow(/目录/);
    await fs.writeFile(file, "not an image, definitely invalid");
    await expect(validateReferences([file], [file], root)).rejects.toThrow(/PNG/);
  });
});

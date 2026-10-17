import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { imageRefsArgs } from "../../src/agent/codex-runner.js";
import { validateReferences } from "../../src/agent/image-references.js";
import { tmp } from "./helpers.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
describe("本票据参考图范围", () => {
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
  it("无附件也覆盖 IMAGE_REFS；拒绝 TOML 注入、相对路径、遍历与逗号", () => {
    expect(imageRefsArgs()).toEqual(["-c", 'mcp_servers.image_gen.env.IMAGE_REFS=""']);
    const good = path.resolve("/data/incoming/t/1.png");
    expect(imageRefsArgs([good])[1]).toBe('mcp_servers.image_gen.env.IMAGE_REFS=' + JSON.stringify(good.replace(/\\/g, "/")));
    for (const bad of ['x', '/data/../key', '/data/a,b', '/data/a"', '/data/a\n', '/data/a b']) expect(() => imageRefsArgs([bad])).toThrow(/IMAGE_REFS/);
  });
});

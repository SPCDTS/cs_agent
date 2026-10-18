import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { imageRefsArgs } from "../../src/agent/codex-runner.js";
import { ContextStore } from "../../src/context/store.js";
import { mediaFixture } from "../context/media-fixture.js";
import { validateReferencesWithMedia, validateReferences } from "../../src/agent/image-references.js";
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

describe("媒体库参考图范围", () => {
  it("票据与媒体取并集，all 可跨域，拒绝越权、未登记、skipped 和超过三张", async () => {
    const dir = tmp(), store = new ContextStore(dir);
    try {
      const media = await mediaFixture(store, dir);
      const access = { kind: "scope", scope: "group:7" } as const;
      const opts = { dataDir: dir, access, openStore: () => store };
      const incoming = path.join(dir, "incoming", "t"), ticket = path.join(incoming, "1.png");
      await fs.mkdir(incoming, { recursive: true }); await fs.writeFile(ticket, PNG);
      expect(await validateReferencesWithMedia([ticket, media], [ticket], incoming, opts)).toEqual([await fs.realpath(ticket), media]);
      expect(await validateReferencesWithMedia([media], [], incoming, { ...opts, access: { kind: "all" } })).toEqual([media]);
      for (const denied of [undefined, { kind: "scope", scope: "private:1" } as const, { kind: "scope", scope: "group:8" } as const])
        await expect(validateReferencesWithMedia([media], [], incoming, { ...opts, access: denied })).rejects.toThrow(/范围/);
      await expect(validateReferencesWithMedia([ticket], [], incoming, opts)).rejects.toThrow(/范围/);
      await expect(validateReferencesWithMedia([media, media, media, media], [], incoming, opts)).rejects.toThrow(/最多/);
      await mediaFixture(store, dir, "group:7", "media", "skipped");
      await expect(validateReferencesWithMedia([media], [], incoming, opts)).rejects.toThrow(/范围/);
    } finally { store.close(); }
  });
  it("即使数据库登记，非媒体路径和媒体目录链接仍拒绝", async () => {
    const dir = tmp(), store = new ContextStore(dir);
    try {
      const media = await mediaFixture(store, dir);
      const row = store.message({ kind: "all" }, "media")!.row;
      const outside = path.join(dir, "outside.png"); await fs.writeFile(outside, PNG);
      const saved = store.media(row.scope, row.message_id)[0]!;
      store.saveMedia(row, [{ ...saved, path: outside }], row.text);
      const opts = { dataDir: dir, access: { kind: "all" } as const, openStore: () => store };
      await expect(validateReferencesWithMedia([outside], [], "", opts)).rejects.toThrow(/媒体路径/);
      store.saveMedia(row, [saved], row.text);
      const root = path.join(dir, "media"), moved = path.join(dir, "moved");
      await fs.rename(root, moved); await fs.symlink(moved, root, process.platform === "win32" ? "junction" : "dir");
      await expect(validateReferencesWithMedia([media], [], "", opts)).rejects.toThrow(/符号链接/);
    } finally { store.close(); }
  });
});

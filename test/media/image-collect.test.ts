import { mkdirSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectNewImages, listFiles } from "../../src/media/image-collect.js";
import { tmp } from "../agent/helpers.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);

describe("collectNewImages", () => {
  it("returns only files created after the snapshot, ≤4, oldest first, magic-checked", async () => {
    const dir = tmp("cs-collect-");
    writeFileSync(path.join(dir, "before.png"), PNG);
    const before = await listFiles(dir);
    const t = Date.now() / 1000;
    for (let i = 0; i < 6; i++) {
      const f = path.join(dir, `n${i}.png`);
      writeFileSync(f, PNG);
      utimesSync(f, t + i, t + i);
    }
    writeFileSync(path.join(dir, "fake.png"), "not really a png at all");
    writeFileSync(path.join(dir, "tiny.png"), PNG.subarray(0, 8));
    mkdirSync(path.join(dir, "sub"));
    writeFileSync(path.join(dir, "sub", "deep.jpg"), JPEG);
    utimesSync(path.join(dir, "sub", "deep.jpg"), t - 10, t - 10);

    const got = await collectNewImages(dir, before);
    expect(got).toHaveLength(4);
    expect(got.map((f) => path.basename(f))).toEqual(["deep.jpg", "n0.png", "n1.png", "n2.png"]);
    expect(got.every((f) => f === realpathSync(f))).toBe(true);
  });

  it("missing dir → nothing; symlinks are not followed", async () => {
    const dir = tmp("cs-collect-");
    expect(await collectNewImages(path.join(dir, "nope"), new Set())).toEqual([]);
    if (process.platform !== "win32") {
      const outside = path.join(tmp("cs-collect-out-"), "x.png");
      writeFileSync(outside, PNG);
      symlinkSync(outside, path.join(dir, "link.png"));
      expect(await collectNewImages(dir, new Set())).toEqual([]);
    }
  });
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isSupportedImage } from "../../src/media/limits.js";
import { prepareImages } from "../../src/qq/image.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(8)]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.from([1, 0, 1, 0]), Buffer.alloc(6), Buffer.from([0x3b])]);

const root = mkdtempSync(join(tmpdir(), "qq-img-root-"));
const outside = mkdtempSync(join(tmpdir(), "qq-img-out-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function file(dir: string, name: string, data: Buffer): string {
  const p = join(dir, name);
  writeFileSync(p, data);
  return p;
}

describe("image validation", () => {
  it("recognises PNG/JPEG/WebP/GIF magic bytes", () => {
    for (const b of [PNG, JPEG, WEBP, GIF]) expect(isSupportedImage(b)).toBe(true);
    expect(isSupportedImage(Buffer.from("not an image at all"))).toBe(false);
  });

  it("builds base64:// segments", () => {
    const segs = prepareImages([file(root, "a.png", PNG), file(root, "b.gif", GIF)], root);
    expect(segs).toEqual([
      { type: "image", data: { file: "base64://" + PNG.toString("base64") } },
      { type: "image", data: { file: "base64://" + GIF.toString("base64") } },
    ]);
    expect(prepareImages([], root)).toEqual([]);
  });

  it("rejects bad magic", () => {
    expect(() => prepareImages([file(root, "bad.png", Buffer.from("plain text, definitely not png"))], root)).toThrow(/PNG/);
  });

  it("rejects files outside the root and traversal", () => {
    expect(() => prepareImages([file(outside, "x.png", PNG)], root)).toThrow(/目录/);
    expect(() => prepareImages([join(root, "..", "nope.png")], root)).toThrow();
    expect(() => prepareImages([root], root)).toThrow();
  });

  it("rejects more than 4 images, missing and tiny files", () => {
    const p = file(root, "c.png", PNG);
    expect(() => prepareImages([p, p, p, p, p], root)).toThrow(/4/);
    expect(() => prepareImages([join(root, "missing.png")], root)).toThrow();
    expect(() => prepareImages([file(root, "tiny.png", PNG.subarray(0, 8))], root)).toThrow(/12 B/);
  });

  it("rejects total over 20 MiB", () => {
    const big = Buffer.concat([PNG, Buffer.alloc(7 * 1024 * 1024)]);
    const p = file(root, "big.png", big);
    expect(() => prepareImages([p, p, p], root)).toThrow(/20 MiB/);
  });
});

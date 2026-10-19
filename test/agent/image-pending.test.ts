import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readPendingImages, savePendingImage, PendingImageMarkerError } from "../../src/media/gen/image-pending.js";
import { tmp } from "./helpers.js";

describe("附件 marker 边界校验", () => {
  const job = (dir: string) => ({ backend: "http", filenamePrefix: "cs-test", options: { prompt: "猫" },
    callDir: path.join(dir, "call-1"), submittedAt: 1, status: "intent" as const });

  it("接受最多八条意图并原子更新 prompt_id 和 done", async () => {
    const dir = tmp();
    for (let i = 0; i < 8; i++) await savePendingImage(dir, { ...job(dir), filenamePrefix: `cs-${i}` });
    await savePendingImage(dir, { ...job(dir), filenamePrefix: "cs-0", prompt_id: "accepted", status: "done" });
    expect(await readPendingImages(dir)).toHaveLength(8);
    await expect(savePendingImage(dir, { ...job(dir), filenamePrefix: "cs-9" })).rejects.toThrow();
    expect((await readPendingImages(dir))[0]).toMatchObject({ prompt_id: "accepted", status: "done" });
    expect((await fs.readdir(dir)).filter(f => f.endsWith(".tmp"))).toEqual([]);
  });

  it.each([
    { prompt_id: "x".repeat(257) }, { backend: "x".repeat(65) }, { filenamePrefix: "x".repeat(129) },
    { callDir: "x".repeat(1025) }, { options: { prompt: "x", reference_images: ["x".repeat(1025)] } },
    { unexpected: true }, { options: { prompt: "x", count: 5 } }, { submittedAt: -1 },
  ])("拒绝超长字段或无效结构：%j", async patch => {
    const dir = tmp();
    await fs.writeFile(path.join(dir, "pending-jobs.json"), JSON.stringify([{ ...job(dir), ...patch }]), "utf8");
    await expect(readPendingImages(dir)).rejects.toBeInstanceOf(PendingImageMarkerError);
  });

  it("lstat 拒绝符号链接且不读取链接目标", async () => {
    const dir = tmp(), target = tmp();
    // Windows junction 无需开发者模式；其 lstat 同样报告符号链接。
    await fs.symlink(target, path.join(dir, "pending-jobs.json"), process.platform === "win32" ? "junction" : "dir");
    await expect(readPendingImages(dir)).rejects.toBeInstanceOf(PendingImageMarkerError);
    expect(await fs.readdir(target)).toEqual([]);
  });
});

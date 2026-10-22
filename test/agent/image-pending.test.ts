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

it("清单的读改写与 MCP 追加共用锁：锁被占用时移除等待，释放后只移除指定任务、保留并发追加的任务", async () => {
  const { savePendingImage, removePendingImages, readPendingImages, PENDING_IMAGE_JOBS } = await import("../../src/media/gen/image-pending.js");
  const { promises: fsp } = await import("node:fs");
  const pathMod = (await import("node:path")).default;
  const { tmp: mk } = await import("./helpers.js");
  const dir = mk("cs-pending-lock-");
  const job = (id: string) => ({ prompt_id: id, backend: "stub", filenamePrefix: "cs-" + id, options: { prompt: id }, callDir: pathMod.join(dir, "call-1"), submittedAt: 1, status: "submitted" as const });
  await savePendingImage(dir, job("a"));
  const lock = pathMod.join(dir, PENDING_IMAGE_JOBS + ".lock");
  await fsp.writeFile(lock, "held");
  let removed = false;
  const removal = removePendingImages(dir, new Set(["cs-a"])).then(() => { removed = true; });
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(removed).toBe(false);
  await fsp.rm(lock);
  await Promise.all([removal, savePendingImage(dir, job("b")), savePendingImage(dir, job("c"))]);
  expect((await readPendingImages(dir)).map(j => j.prompt_id).sort()).toEqual(["b", "c"]);
});

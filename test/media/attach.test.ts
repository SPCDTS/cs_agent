import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { attachmentName, DEFAULT_ATTACHMENT_LIMITS, readAttachmentData, readFileAttachments, registerFileAttachment, registerImageAttachment } from "../../src/media/attach.js";
import { collectNewImages } from "../../src/media/gen/image-collect.js";
import { MAX_IMAGE_BYTES } from "../../src/media/limits.js";
import { loadConfig } from "../../src/config.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cs-attach-")); dirs.push(root);
  const workdir = path.join(root, "ws"), fileDir = path.join(root, "files"), attachDir = path.join(root, "images");
  await fs.mkdir(workdir);
  const write = async (name: string, data: string | Buffer = "中文内容") => {
    const file = path.join(workdir, name); await fs.writeFile(file, data); return file;
  };
  return { root, workdir, fileDir, attachDir, write };
}
const png = (n = 0, size = 32) => { const b = Buffer.alloc(size, n); Buffer.from("89504e470d0a1a0a", "hex").copy(b); return b; };

describe("附件登记", () => {
  it("登记工作区副本、相对路径、清单和返回文本，源文件后续改动不影响发送", async () => {
    const o = await setup(); const file = await o.write("报告.txt");
    expect(await registerFileAttachment({ ...o, path: "报告.txt" })).toBe("已登记，将随回复发送（第 1/3 个，0.00 MiB）");
    const entries = await readFileAttachments(o.fileDir);
    expect(entries).toEqual([expect.objectContaining({ name: "报告.txt", originalPath: await fs.realpath(file), filename: "1-报告.txt", source: "workspace", bytes: 12 })]);
    await fs.writeFile(file, "已改动");
    expect((await readAttachmentData(o.fileDir, entries[0]!)).toString()).toBe("中文内容");
  });

  it("工作区外、相邻目录、URL、目录和不存在的文件都不能登记", async () => {
    const o = await setup(); const outside = path.join(o.root, "secret.txt"); await fs.writeFile(outside, "secret");
    await fs.mkdir(path.join(o.root, "ws-other")); await fs.writeFile(path.join(o.root, "ws-other", "a"), "a");
    for (const file of [outside, "../secret.txt", "../ws-other/a", "https://example.com/a", "missing", o.workdir]) {
      await expect(registerFileAttachment({ ...o, path: file })).rejects.toThrow();
      await expect(registerImageAttachment({ ...o, path: file })).rejects.toThrow();
    }
  });

  it("拒绝文件软链接及路径中指向工作区内的目录链接", async () => {
    const o = await setup(); const target = await o.write("real.png", png());
    const link = path.join(o.workdir, "link.png"); await fs.symlink(target, link, "file");
    const nested = path.join(o.workdir, "nested"); await fs.mkdir(nested); await fs.writeFile(path.join(nested, "image"), png());
    const junction = path.join(o.workdir, "alias"); await fs.symlink(nested, junction, "junction");
    for (const file of [link, path.join(junction, "image")]) {
      await expect(registerFileAttachment({ ...o, path: file, mediaCheck: () => true })).rejects.toThrow("软链接");
      await expect(registerImageAttachment({ ...o, path: file, mediaCheck: () => true })).rejects.toThrow("软链接");
    }
  });

  it("已召回媒体由当前访问范围回调判定，图片与文件均支持", async () => {
    const o = await setup(); const file = path.join(o.root, "media-hash"); await fs.writeFile(file, png());
    const canonical = await fs.realpath(file);
    for (const register of [registerFileAttachment, registerImageAttachment]) {
      await expect(register({ ...o, path: file, mediaCheck: () => false })).rejects.toThrow("只能发送工作区内的文件或已召回的图片");
      expect(await register({ ...o, path: file, mediaCheck: p => p === canonical })).toContain("已登记");
    }
    expect((await readFileAttachments(o.fileDir))[0]!.source).toBe("media");
  });

  it("校验空文件、图片最小大小、单个上限及魔数", async () => {
    const o = await setup();
    await expect(registerFileAttachment({ ...o, path: await o.write("empty", "") })).rejects.toThrow();
    await expect(registerFileAttachment({ ...o, path: await o.write("large", "12345"), limits: { ...DEFAULT_ATTACHMENT_LIMITS, maxBytes: 4 } })).rejects.toThrow("普通文件");
    for (const [name, data] of [["short", png(0, 11)], ["huge", png(0, MAX_IMAGE_BYTES + 1)], ["bad", Buffer.alloc(20)]] as const) {
      await expect(registerImageAttachment({ ...o, path: await o.write(name, data) })).rejects.toThrow();
    }
  });

  it("文件名取 basename、去控制字符并限制长度，大小写/尾点不能绕过黑名单", async () => {
    const o = await setup(); const file = await o.write("source", "hello");
    expect(attachmentName("C:\\secret\\报\u0000告\u0085.txt")).toBe("报告.txt");
    expect(Array.from(attachmentName("图".repeat(150) + ".pdf"))).toHaveLength(120);
    for (const name of ["a.exe", "a.BAT ", "a.ps1.", "x.j\u0000s", "a".repeat(130) + ".EXE"]) {
      await expect(registerFileAttachment({ ...o, path: file, name })).rejects.toThrow("扩展名");
    }
    await registerFileAttachment({ ...o, path: file, name: "../../报\u0001告.txt" });
    expect((await readFileAttachments(o.fileDir))[0]!.name).toBe("报告.txt");
    await expect(registerFileAttachment({ ...o, path: file, name: "a.zip", limits: { ...DEFAULT_ATTACHMENT_LIMITS, denyExtensions: [".zip"] } })).rejects.toThrow("扩展名");
  });

  it("并行登记按 sha256 去重并限制数量；重建调用复用 manifest", async () => {
    const o = await setup(); const file = await o.write("a"); const same = await o.write("b");
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => registerFileAttachment({ ...o, path: i % 2 ? same : file })));
    expect(new Set(results).size).toBe(1); expect(await readFileAttachments(o.fileDir)).toHaveLength(1);
    for (const name of ["c", "d"]) await registerFileAttachment({ ...o, path: await o.write(name, name) });
    await expect(registerFileAttachment({ ...o, path: await o.write("e", "e") })).rejects.toThrow("最多 3");
    expect(await registerFileAttachment({ ...o, path: same })).toContain("第 1/3");
  });

  it("图片与已有生图合计不超过四张，重复登记不占名额，无图片扩展名也能收集", async () => {
    const o = await setup(); await fs.mkdir(path.join(o.attachDir, "call-1"), { recursive: true });
    await fs.writeFile(path.join(o.attachDir, "call-1", "generated.png"), png());
    expect(await registerImageAttachment({ ...o, path: await o.write("same", png()) })).toContain("第 1/4");
    for (let n = 1; n < 4; n++) expect(await registerImageAttachment({ ...o, path: await o.write(`${n}.json`, png(n)) })).toContain(`第 ${n + 1}/4`);
    expect(await collectNewImages(o.attachDir, new Set())).toHaveLength(4);
    await expect(registerImageAttachment({ ...o, path: await o.write("fifth", png(5)) })).rejects.toThrow("最多 4");
  });

  it("图片合计不超过 20 MiB", async () => {
    const o = await setup();
    for (let n = 1; n <= 2; n++) await registerImageAttachment({ ...o, path: await o.write(`${n}.png`, png(n, MAX_IMAGE_BYTES)) });
    await expect(registerImageAttachment({ ...o, path: await o.write("3.png", png(3)) })).rejects.toThrow("合计");
  });

  it("缺失清单为空，损坏/路径穿越清单及副本篡改拒绝发送", async () => {
    const o = await setup(); expect(await readFileAttachments(o.fileDir)).toEqual([]);
    await registerFileAttachment({ ...o, path: await o.write("a") });
    const [entry] = await readFileAttachments(o.fileDir);
    await fs.writeFile(path.join(o.fileDir, entry!.filename), "改动改动");
    await expect(readAttachmentData(o.fileDir, entry!)).rejects.toThrow("校验失败");
    await fs.writeFile(path.join(o.fileDir, "manifest.json"), JSON.stringify([{ ...entry, filename: "../escape" }]));
    await expect(readFileAttachments(o.fileDir)).rejects.toThrow("manifest");
    await fs.writeFile(path.join(o.fileDir, "manifest.json"), "broken");
    await expect(readFileAttachments(o.fileDir)).rejects.toThrow();
  });

  it("配置默认值与显式覆盖", () => {
    expect(loadConfig({})).toMatchObject({ CODEX_IMAGE_GEN: "off", ATTACH_FILE_MAX_MB: 20, ATTACH_FILES_MAX: 3, ATTACH_FILE_DENY_EXT: DEFAULT_ATTACHMENT_LIMITS.denyExtensions });
    expect(loadConfig({ ATTACH_FILE_MAX_MB: "5", ATTACH_FILES_MAX: "2", ATTACH_FILE_DENY_EXT: ".ZIP, .Exe" })).toMatchObject({ ATTACH_FILE_MAX_MB: 5, ATTACH_FILES_MAX: 2, ATTACH_FILE_DENY_EXT: [".zip", ".exe"] });
    expect(() => loadConfig({ CODEX_IMAGE_GEN: "invalid" })).toThrow();
  });
});

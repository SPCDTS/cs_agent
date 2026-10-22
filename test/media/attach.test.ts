import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { attachmentName, DEFAULT_ATTACHMENT_LIMITS, prepareSendAttachments, readAttachmentData, type AttachmentLimits, type AttachmentSource } from "../../src/media/attach.js";
import { MAX_IMAGE_BYTES } from "../../src/media/limits.js";
import { loadConfig } from "../../src/config.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cs-attach-")); dirs.push(root);
  const workdir = path.join(root, "ws");
  await fs.mkdir(workdir);
  const write = async (name: string, data: string | Buffer = "中文内容") => {
    const file = path.join(workdir, name); await fs.writeFile(file, data); return file;
  };
  return { root, workdir, write };
}
const png = (n = 0, size = 32) => { const b = Buffer.alloc(size, n); Buffer.from("89504e470d0a1a0a", "hex").copy(b); return b; };

type Source = Omit<AttachmentSource, "path">;
const sendFile = async (o: Source, file: string, name?: string, limits?: AttachmentLimits) =>
  (await prepareSendAttachments(o, { files: [{ path: file, ...(name ? { name } : {}) }] }, limits)).files[0]!;
const sendImage = async (o: Source, file: string) => (await prepareSendAttachments(o, { images: [file] })).images[0]!;
const both = [sendFile, sendImage] as const;

describe("send_message 附件校验", () => {
  it("工作区内的相对路径可发送，返回内容、规范路径与来源", async () => {
    const o = await setup(); const file = await o.write("报告.txt");
    expect(await sendFile(o, "报告.txt")).toMatchObject({ name: "报告.txt", canonical: await fs.realpath(file), source: "workspace" });
  });

  it("工作区外、相邻目录、URL、目录和不存在的文件都不能发送", async () => {
    const o = await setup(); const outside = path.join(o.root, "secret.txt"); await fs.writeFile(outside, "secret");
    await fs.mkdir(path.join(o.root, "ws-other")); await fs.writeFile(path.join(o.root, "ws-other", "a"), "a");
    for (const file of [outside, "../secret.txt", "../ws-other/a", "https://example.com/a", "missing", o.workdir]) {
      for (const send of both) await expect(send(o, file)).rejects.toThrow();
    }
  });

  it("拒绝文件软链接及路径中指向工作区内的目录链接", async () => {
    const o = await setup(); const target = await o.write("real.png", png());
    const link = path.join(o.workdir, "link.png"); await fs.symlink(target, link, "file");
    const nested = path.join(o.workdir, "nested"); await fs.mkdir(nested); await fs.writeFile(path.join(nested, "image"), png());
    const junction = path.join(o.workdir, "alias"); await fs.symlink(nested, junction, "junction");
    for (const file of [link, path.join(junction, "image")]) {
      for (const send of both) await expect(send({ ...o, mediaCheck: () => true }, file)).rejects.toThrow("软链接");
    }
  });

  it("额外来源支持图片与文件，来源按工作区、额外目录、召回媒体排序", async () => {
    const o = await setup(); const generated = path.join(o.root, "generated"); await fs.mkdir(generated);
    const file = path.join(generated, "image.png"); await fs.writeFile(file, png());
    const options = { ...o, extraRoots: [path.join(o.root, "missing"), generated, o.workdir], mediaCheck: () => { throw new Error("不应查询媒体库"); } };
    for (const send of both) expect((await send(options, file)).source).toBe("generated");
    await fs.writeFile(path.join(generated, "local.png"), png(1));
    const local = await o.write("local.png", png(2));
    expect(await sendFile(options, "local.png")).toMatchObject({ source: "workspace", canonical: await fs.realpath(local) });
  });

  it("额外来源不能放行根目录、相邻目录或其他会话，未授权时仍可检查召回媒体", async () => {
    const o = await setup(); const generated = path.join(o.root, "generated"); await fs.mkdir(generated);
    const outside = path.join(o.root, "generated-other"); await fs.mkdir(outside);
    const file = path.join(outside, "image.png"); await fs.writeFile(file, png());
    for (const send of both) {
      for (const source of [generated, file]) await expect(send({ ...o, extraRoots: [generated] }, source)).rejects.toThrow();
      expect((await send({ ...o, extraRoots: [generated], mediaCheck: p => p === file }, file)).source).toBe("media");
    }
  });

  it("额外来源拒绝文件、父目录及来源根目录的软链接", async () => {
    const o = await setup(); const generated = path.join(o.root, "generated"); await fs.mkdir(generated);
    const target = path.join(generated, "real.png"); await fs.writeFile(target, png());
    const fileLink = path.join(generated, "link.png"); await fs.symlink(target, fileLink, "file");
    const nested = path.join(generated, "nested"); await fs.mkdir(nested); await fs.writeFile(path.join(nested, "image.png"), png());
    const dirLink = path.join(generated, "alias"); await fs.symlink(nested, dirLink, "junction");
    const rootLink = path.join(o.root, "root-alias"); await fs.symlink(generated, rootLink, "junction");
    const outside = await o.write("outside.png", png());
    const escape = path.join(generated, "escape.png"); await fs.symlink(outside, escape, "file");
    for (const send of both) {
      for (const file of [fileLink, path.join(dirLink, "image.png"), path.join(rootLink, "real.png"), escape]) {
        await expect(send({ ...o, extraRoots: [generated, rootLink], mediaCheck: () => true }, file)).rejects.toThrow("软链接");
      }
      await expect(send({ ...o, extraRoots: [rootLink] }, target)).rejects.toThrow();
    }
  });

  it("已召回媒体由当前访问范围回调判定，图片与文件均支持", async () => {
    const o = await setup(); const file = path.join(o.root, "media-hash"); await fs.writeFile(file, png());
    const canonical = await fs.realpath(file);
    for (const send of both) {
      await expect(send({ ...o, mediaCheck: () => false }, file)).rejects.toThrow("只能发送工作区内的文件或已召回的图片");
      expect((await send({ ...o, mediaCheck: p => p === canonical }, file)).source).toBe("media");
    }
  });

  it("媒体归属校验失败时仍返回来源限制错误", async () => {
    const o = await setup(); const file = path.join(o.root, "media"); await fs.writeFile(file, png());
    await expect(sendFile({ ...o, mediaCheck: () => { throw new Error("数据库未就绪"); } }, file)).rejects.toThrow("只能发送工作区内的文件或已召回的图片");
  });

  it.skipIf(process.platform === "win32")("工作区 FIFO 在打开前拒绝，不等待写入端", async () => {
    const o = await setup(); const file = path.join(o.workdir, "pipe"); execFileSync("mkfifo", [file]);
    await expect(sendFile(o, file)).rejects.toThrow("普通文件");
  });

  it("校验空文件、图片最小大小、单个上限及魔数", async () => {
    const o = await setup();
    await expect(sendFile(o, await o.write("empty", ""))).rejects.toThrow();
    await expect(sendFile(o, await o.write("large", "12345"), undefined, { ...DEFAULT_ATTACHMENT_LIMITS, maxBytes: 4 })).rejects.toThrow("普通文件");
    for (const [name, data] of [["short", png(0, 11)], ["huge", png(0, MAX_IMAGE_BYTES + 1)], ["bad", Buffer.alloc(20)]] as const) {
      await expect(sendImage(o, await o.write(name, data))).rejects.toThrow();
    }
  });

  it("文件名取 basename、去控制字符并限制长度，大小写/尾点不能绕过黑名单", async () => {
    const o = await setup(); const file = await o.write("source", "hello");
    expect(attachmentName("C:\\secret\\报\u0000告\u0085.txt")).toBe("报告.txt");
    expect(Array.from(attachmentName("图".repeat(150) + ".pdf"))).toHaveLength(120);
    for (const name of ["a.exe", "a.BAT ", "a.ps1.", "x.j\u0000s", "a".repeat(130) + ".EXE"]) {
      await expect(sendFile(o, file, name)).rejects.toThrow("扩展名");
    }
    expect((await sendFile(o, file, "../../报\u0001告.txt")).name).toBe("报告.txt");
    await expect(sendFile(o, file, "a.zip", { ...DEFAULT_ATTACHMENT_LIMITS, denyExtensions: [".zip"] })).rejects.toThrow("扩展名");
  });

  it("文件数量与图片合计大小受限", async () => {
    const o = await setup();
    const files = await Promise.all(["a", "b", "c", "d"].map(async name => ({ path: await o.write(name, name) })));
    await expect(prepareSendAttachments(o, { files })).rejects.toThrow("数量");
    await expect(prepareSendAttachments(o, { files: files.slice(0, 3) }, { ...DEFAULT_ATTACHMENT_LIMITS, maxFiles: 2 })).rejects.toThrow("数量");
    const images = [];
    for (let n = 1; n <= 3; n++) images.push(await o.write(`${n}.png`, png(n, n < 3 ? MAX_IMAGE_BYTES : 32)));
    await expect(prepareSendAttachments(o, { images })).rejects.toThrow("合计");
  });

  it("读取副本时校验 sha256，拒绝篡改与路径穿越", async () => {
    const o = await setup(); const dir = path.join(o.root, "copies"); await fs.mkdir(dir);
    const { files: [entry] } = await prepareSendAttachments(o, { files: [{ path: await o.write("a") }] });
    await fs.writeFile(path.join(dir, "1-a"), entry!.data);
    const row = { originalPath: entry!.canonical, filename: "1-a", name: "a", bytes: entry!.data.length, sha256: entry!.sha256, source: entry!.source };
    expect((await readAttachmentData(dir, row)).toString()).toBe("中文内容");
    await fs.writeFile(path.join(dir, "1-a"), "改动改动");
    await expect(readAttachmentData(dir, row)).rejects.toThrow("校验失败");
    await expect(readAttachmentData(dir, { ...row, filename: "../escape" })).rejects.toThrow("路径无效");
  });

  it("配置默认值与显式覆盖", () => {
    expect(loadConfig({})).toMatchObject({ ATTACH_FILE_MAX_MB: 20, ATTACH_FILES_MAX: 3, ATTACH_FILE_DENY_EXT: DEFAULT_ATTACHMENT_LIMITS.denyExtensions });
    expect(loadConfig({ ATTACH_FILE_MAX_MB: "5", ATTACH_FILES_MAX: "2", ATTACH_FILE_DENY_EXT: ".ZIP, .Exe" })).toMatchObject({ ATTACH_FILE_MAX_MB: 5, ATTACH_FILES_MAX: 2, ATTACH_FILE_DENY_EXT: [".zip", ".exe"] });
    expect(() => loadConfig({ ATTACH_FILES_MAX: "invalid" })).toThrow();
  });
});

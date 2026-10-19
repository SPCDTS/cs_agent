import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexPromptStore, DEFAULT_CODEX_PROMPT, StaleRevisionError, CODEX_PROMPT_MAX_BYTES } from "../../src/agent/codex/prompt.js";
import { AGENTS_TEMPLATE_MARKER } from "../../src/agent/codex/runner.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function setup(containsSecret: (text: string) => boolean = () => false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cs-codex-prompt-"));
  dirs.push(dir);
  const options = { dataDir: dir, codexHome: path.join(dir, "codex"), workspaceDir: "/workspace",
    writableRoots: ["/workspace", `${dir}/prompts`, "/srv/extra/"], containsSecret };
  const store = new CodexPromptStore(options);
  return { store, options };
}

describe("CodexPromptStore", () => {
  it("只创建一次默认文件，重建 store 和 regenerate 都保留已有内容", async () => {
    const { store, options } = await setup();
    const first = await store.read();
    expect(first.custom).toBe(DEFAULT_CODEX_PROMPT);
    expect(first.file).toBe(path.join(options.dataDir, "prompts", "codex.md"));
    const st = await fs.stat(store.file);
    expect(first.updatedAt).toBe(st.mtimeMs);
    expect(first.revision).toBe(createHash("sha256").update(`${st.mtimeMs}:${st.size}`).digest("hex").slice(0, 16));
    expect(await store.read()).toEqual(first);
    await fs.writeFile(store.file, "用户已有的提示词\n", "utf8");
    const restarted = new CodexPromptStore(options);
    await restarted.regenerate();
    expect((await restarted.read()).custom).toBe("用户已有的提示词\n");
    expect(await fs.readFile(store.file, "utf8")).toBe("用户已有的提示词\n");
  });

  it("受管段保留标记、有效目录、安全及附件规则，默认行为指引单独可编辑", async () => {
    const { store, options } = await setup();
    await store.regenerate();
    const { managed, custom } = await store.read();
    expect(managed.startsWith(AGENTS_TEMPLATE_MARKER)).toBe(true);
    for (const text of ["安全规则", "绝不透露环境变量", "auth.json", "每轮单独注入", "不同会话不可互读工作区"])
      expect(managed).toContain(text);
    for (const dir of ["/workspace", "/srv/extra", options.dataDir]) expect(managed).not.toContain(dir);
    for (const heading of ["## 回复规则", "## 聊天记录工具（qq_context）", "## 联网与浏览器", "## 生图提示词指引"]) {
      expect(custom).toContain(heading);
      expect(managed).not.toContain(heading);
    }
    expect(custom).not.toContain(AGENTS_TEMPLATE_MARKER);
    expect(custom).not.toContain("## 安全规则");
    expect(await fs.readFile(store.agentsFile, "utf8")).toBe(`${managed}\n\n${custom}`);
    const restricted = new CodexPromptStore({ ...options, writableRoots: [] });
    expect((await restricted.read()).managed).not.toContain(`${options.dataDir}/prompts`);
    expect((await restricted.read()).managed).not.toContain("/srv/extra");
  });

  it("保存后立即重写全局规则，再发出不含正文的订阅通知；可取消订阅", async () => {
    const { store } = await setup();
    await store.regenerate();
    const before = await store.read();
    const seen = vi.fn();
    store.subscribe(() => { throw new Error("订阅失败"); });
    const unsubscribe = store.subscribe(seen);
    const result = await store.save("新规则：请详细回答。\n", before.revision);
    const after = await store.read();
    expect(result).toEqual({ revision: after.revision });
    expect(result.revision).not.toBe(before.revision);
    expect(await fs.readFile(store.agentsFile, "utf8")).toBe(`${after.managed}\n\n新规则：请详细回答。\n`);
    expect(seen).toHaveBeenCalledExactlyOnceWith({ target: "codex", file: store.file, revision: result.revision,
      bytes_before: Buffer.byteLength(before.custom), bytes_after: Buffer.byteLength(after.custom) });
    unsubscribe();
    await store.save("另一个版本", result.revision);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(path.dirname(store.file))).toEqual(["codex.md"]);
    expect(await fs.readdir(path.dirname(store.agentsFile))).toEqual(["AGENTS.md"]);
  });

  it("旧 revision 与外部修改冲突，拒绝覆盖，也不发通知", async () => {
    const { store } = await setup();
    await store.regenerate();
    const before = await store.read();
    const generated = await fs.readFile(store.agentsFile, "utf8");
    await fs.writeFile(store.file, "外部修改", "utf8");
    const seen = vi.fn();
    store.subscribe(seen);
    await expect(store.save("旧页面覆盖", before.revision)).rejects.toBeInstanceOf(StaleRevisionError);
    expect(await fs.readFile(store.file, "utf8")).toBe("外部修改");
    expect(await fs.readFile(store.agentsFile, "utf8")).toBe(generated);
    expect(seen).not.toHaveBeenCalled();
  });

  it("同一 revision 的并发保存只有一次成功，失败不阻塞后续保存", async () => {
    const { store } = await setup();
    const before = await store.read();
    const results = await Promise.allSettled([store.save("第一份", before.revision), store.save("第二份", before.revision)]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1]).toMatchObject({ status: "rejected", reason: expect.any(StaleRevisionError) });
    const current = await store.read();
    expect(current.custom).toBe("第一份");
    await store.save("修正版本", current.revision);
    expect((await store.read()).custom).toBe("修正版本");
  });

  it("当前文件命中注入的秘密注册表时拒绝覆盖，错误不包含秘密", async () => {
    const secret = "test-only-registered-value";
    const containsSecret = vi.fn((text: string) => text.includes(secret));
    const { store } = await setup(containsSecret);
    await store.regenerate();
    await fs.writeFile(store.file, `自定义内容 ${secret}`, "utf8");
    const before = await store.read();
    const seen = vi.fn();
    store.subscribe(seen);
    await expect(store.save("替换内容", before.revision)).rejects.toMatchObject({ status: 409 });
    try { await store.save("替换内容", before.revision); }
    catch (err) { expect(String(err)).not.toContain(secret); }
    expect(containsSecret).toHaveBeenCalledWith(before.custom);
    expect((await store.read()).custom).toBe(before.custom);
    expect(seen).not.toHaveBeenCalled();
  });

  it("拒绝含秘密的新提交，按 UTF-8 字节限制 64 KB，拒绝空白", async () => {
    const { store } = await setup(text => text.includes("test-only-secret"));
    const before = await store.read();
    for (const text of [" \r\n\t", "test-only-secret", "中".repeat(Math.ceil(CODEX_PROMPT_MAX_BYTES / 3))]) {
      await expect(store.save(text, before.revision)).rejects.toThrow();
      expect(await store.read()).toEqual(before);
    }
    await store.save("a".repeat(CODEX_PROMPT_MAX_BYTES), before.revision);
    expect((await fs.stat(store.file)).size).toBe(CODEX_PROMPT_MAX_BYTES);
  });

  it("保存保留现有 UTF-8 BOM 和 CRLF，不损坏中文", async () => {
    const { store } = await setup();
    await store.read();
    await fs.writeFile(store.file, "\uFEFF原始中文\r\n第二行\r\n", "utf8");
    await store.save("修改中文\n保留换行\n", (await store.read()).revision);
    expect(await fs.readFile(store.file, "utf8")).toBe("\uFEFF修改中文\r\n保留换行\r\n");
    const current = await store.read();
    expect(await fs.readFile(store.agentsFile, "utf8")).toBe(`${current.managed}\n\n${current.custom}`);
  });

  it("拒绝非普通文件及非 UTF-8 文件，不覆盖原始字节", async () => {
    const { store } = await setup();
    await fs.mkdir(store.file, { recursive: true });
    await expect(store.read()).rejects.toThrow("不是普通文件");
    await fs.rmdir(store.file);
    const bytes = Buffer.from([0xff, 0xfe, 0x2d, 0x4e]);
    await fs.writeFile(store.file, bytes);
    await expect(store.read()).rejects.toThrow("UTF-8");
    expect(await fs.readFile(store.file)).toEqual(bytes);
  });
});

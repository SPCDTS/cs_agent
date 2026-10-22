import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { basePromptFilename, CodexBasePromptStore, MANAGED_QQ_INSTRUCTIONS } from "../../src/agent/codex/base-prompt.js";
import { QQ_LINK_RULE } from "../../src/agent/send-service.js";
import { log } from "../../src/shared/log.js";
import { tmp } from "./helpers.js";
import { codexRunnerRig } from "./codex-fixture.js";
import { defaultHandlers } from "./codex-app-server/fake-app-server.js";

const MODEL = "codex/gpt-6.1-sol", OTHER = "codex/gpt-6-astra";
const dirs: string[] = [];
const rigs: { close(): Promise<void> }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const r of rigs.splice(0)) await r.close();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function rig(options: { magpie?: boolean; template?: string } = {}) {
  const dir = tmp("cs-base-prompt-"); dirs.push(dir);
  const codexHome = path.join(dir, "codex");
  await fs.mkdir(codexHome);
  const cache = async (template: string, model = MODEL) => fs.writeFile(path.join(codexHome, "models_cache.json"),
    JSON.stringify({ models: [{ slug: model, model_messages: { instructions_template: template }, base_instructions: "短回退" }] }), "utf8");
  if (options.template !== undefined) await cache(options.template);
  const store = new CodexBasePromptStore({ dataDir: dir, codexHome,
    ...(options.magpie ? { magpieUrl: "http://magpie.test/v1/", magpieKey: "test-gateway-key" } : {}),
    containsSecret: text => text.includes("credential-secret") });
  const file = (model = MODEL) => path.join(dir, "prompts", "codex-base", basePromptFilename(model));
  const missing = { thread: "" };
  const live = await codexRunnerRig({ dir, model: MODEL, prepareBasePrompt: model => store.prepare(model),
    handlers: () => defaultHandlers({
      "thread/start": () => ({ result: { thread: { id: "base-thread" } } }),
      "thread/resume": m => m.params!.threadId === missing.thread ? { error: { code: -32600, message: "no rollout found for thread id " + missing.thread } }
        : { result: { thread: { id: m.params!.threadId } } },
    }) });
  rigs.push(live);
  await fs.writeFile(path.join(codexHome, "config.toml"), 'model_provider="openai"\n', "utf8");
  return { dir, codexHome, cache, store, file, runner: live.runner, loads: live.loads, missing };
}

describe("按模型基础指令存储", () => {
  it("缓存完整模板原样播种（BOM、CRLF），目录升级不覆盖；恢复后逐字一致", async () => {
    const template = "\uFEFF# 完整基础指令\r\n第二行\r\n";
    const r = await rig({ template });
    const first = (await r.store.read(MODEL))!;
    expect(first.custom).toBe(template);
    expect(first.differs).toBe(false);
    expect(await fs.readFile(r.file())).toEqual(Buffer.from(template, "utf8"));
    await r.cache("新的目录默认\n");
    expect(await r.store.read(MODEL)).toMatchObject({ custom: template, differs: true });
    await r.store.restore(MODEL, first.revision);
    expect(await r.store.read(MODEL)).toMatchObject({ custom: "新的目录默认\n", differs: false });
  });

  it("缓存缺少对应模板时向同一 Magpie 目录回退，精确匹配 slug 并传鉴权", async () => {
    const r = await rig({ magpie: true, template: "缓存中的其它模型" });
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      models: [{ slug: MODEL, model_messages: { instructions_template: "不能串用" } },
        { slug: OTHER, model_messages: { instructions_template: "远端完整模板\r\n" } }],
    })));
    expect((await r.store.read(OTHER))!.custom).toBe("远端完整模板\r\n");
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("http://magpie.test/v1/codex/models", expect.objectContaining({
      headers: { Authorization: "Bearer test-gateway-key", "x-openai-actor-authorization": "cs-agent" },
      redirect: "error", signal: expect.any(AbortSignal),
    }));
    expect(await fs.readFile(r.file(OTHER), "utf8")).toBe("远端完整模板\r\n");
  });

  it("有效缓存不联网，已播种的编辑文件在离线时仍可生成生效文件", async () => {
    const r = await rig({ magpie: true, template: "默认" });
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    await r.store.prepare(MODEL);
    expect(fetcher).not.toHaveBeenCalled();
    await fs.rm(path.join(r.codexHome, "models_cache.json"));
    await r.store.prepare(MODEL);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await r.store.read(MODEL))!.differs).toBeNull();
  });

  it.each(["fallback-only", "empty", "wrong-model", "http-error", "network-error", "bad-json"])(
    "模板不可用（%s）不播种、不传覆盖参数，只告警一次且后续可恢复", async failure => {
      const r = await rig({ magpie: true });
      const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        if (failure === "network-error") throw new Error("credential-secret");
        if (failure === "bad-json") return new Response("not json");
        return new Response(JSON.stringify({ models: [{ slug: failure === "wrong-model" ? OTHER : MODEL,
          base_instructions: "只有回退", model_messages: failure === "fallback-only" ? {} : { instructions_template: "" } }] }),
        { status: failure === "http-error" ? 503 : 200 });
      });
      const warn = vi.spyOn(log, "warn");
      await r.runner.openThread("owner", { mcpEnv: {}, model: MODEL });
      await r.runner.openThread("owner", { mcpEnv: {}, model: MODEL });
      expect(await r.store.read(MODEL)).toBeUndefined();
      await expect(fs.stat(r.file())).rejects.toMatchObject({ code: "ENOENT" });
      expect(r.loads().every(l => !Object.hasOwn(l.config, "model_instructions_file"))).toBe(true);
      expect(warn.mock.calls.filter(c => c[0] === "codex base instructions template unavailable; using codex defaults")).toEqual([
        ["codex base instructions template unavailable; using codex defaults", { model: MODEL }],
      ]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain("credential-secret");
      await r.cache("恢复后的目录");
      fetcher.mockClear();
      expect(await r.store.prepare(MODEL)).toBeDefined();
      expect(fetcher).not.toHaveBeenCalled();
    });

  it("追加受管规则且内容不变时保留 mtime；外部修改与生效文件篡改下一轮重新生成", async () => {
    const r = await rig({ template: "基础内容" });
    const file = (await r.store.prepare(MODEL))!;
    expect(file).toBe(path.join(r.codexHome, "base-instructions", "codex__gpt-6.1-sol.md"));
    expect(await fs.readFile(file, "utf8")).toBe(`基础内容\n\n${MANAGED_QQ_INSTRUCTIONS}`);
    expect(MANAGED_QQ_INSTRUCTIONS).toContain("<!-- cs-agent-base-instructions v1: MANAGED -->");
    expect(MANAGED_QQ_INSTRUCTIONS).toContain("## QQ 回复规则（优先于任何工具说明，包括 web.run 的引用格式要求）");
    expect(MANAGED_QQ_INSTRUCTIONS.split("\n\n")[1]).toBe(QQ_LINK_RULE);
    expect(QQ_LINK_RULE).toContain("技能（skills）里\"附来源链接\"的要求在 QQ 场景一律不适用");
    await fs.utimes(file, new Date(1000), new Date(1000));
    await r.store.prepare(MODEL);
    expect((await fs.stat(file)).mtimeMs).toBe(1000);
    await fs.writeFile(r.file(), "外部编辑\r\n", "utf8");
    await r.store.prepare(MODEL);
    expect(await fs.readFile(file, "utf8")).toBe(`外部编辑\r\n\n\n${MANAGED_QQ_INSTRUCTIONS}`);
    expect((await fs.stat(file)).mtimeMs).not.toBe(1000);
    await fs.writeFile(file, "被修改的生效内容", "utf8");
    await r.store.prepare(MODEL);
    expect(await fs.readFile(file, "utf8")).toContain(MANAGED_QQ_INSTRUCTIONS);
  });

  it("保存保留 BOM/换行、拒绝过期版本、通知监听器；监听异常不影响保存", async () => {
    const r = await rig({ template: "\uFEFF旧\r\n内容\r\n" });
    const first = (await r.store.read(MODEL))!;
    const listener = vi.fn(), off = r.store.subscribe(listener);
    r.store.subscribe(() => { throw new Error("subscriber"); });
    await r.store.save(MODEL, "新\n内容\n", first.revision);
    expect((await r.store.read(MODEL))!.custom).toBe("\uFEFF新\r\n内容\r\n");
    expect(listener).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      target: "codex-base", model: MODEL, file: r.file(), bytes_before: Buffer.byteLength(first.custom),
      bytes_after: Buffer.byteLength("\uFEFF新\r\n内容\r\n"),
    }));
    await expect(r.store.save(MODEL, "过期写入", first.revision)).rejects.toMatchObject({ status: 409 });
    await expect(r.store.restore(MODEL, first.revision)).rejects.toMatchObject({ status: 409 });
    off();
    await r.store.restore(MODEL, (await r.store.read(MODEL))!.revision);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("串行保存只接受一个相同版本；同 mtime/大小外部修改也识别为冲突", async () => {
    const r = await rig({ template: "aa" }), first = (await r.store.read(MODEL))!;
    const results = await Promise.allSettled([r.store.save(MODEL, "bb", first.revision), r.store.save(MODEL, "cc", first.revision)]);
    expect(results.map(x => x.status)).toEqual(["fulfilled", "rejected"]);
    const before = (await r.store.read(MODEL))!, stat = await fs.stat(r.file());
    await fs.writeFile(r.file(), "dd", "utf8");
    await fs.utimes(r.file(), stat.atime, stat.mtime);
    await expect(r.store.save(MODEL, "ee", before.revision)).rejects.toMatchObject({ status: 409 });
  });

  it.each([["空内容", "   "], ["超限", "x".repeat(65537)], ["秘密", "credential-secret"]])("拒绝%s", async (_label, content) => {
    const r = await rig({ template: "原内容" }), first = (await r.store.read(MODEL))!;
    await expect(r.store.save(MODEL, content, first.revision)).rejects.toMatchObject({ status: 409 });
    expect(await fs.readFile(r.file(), "utf8")).toBe("原内容");
  });

  it("已有秘密文件拒绝保存和恢复；非 UTF-8 与过大文件拒绝读取", async () => {
    const r = await rig({ template: "默认" });
    await r.store.read(MODEL);
    await fs.writeFile(r.file(), "credential-secret", "utf8");
    const before = (await r.store.read(MODEL))!;
    await expect(r.store.save(MODEL, "清空", before.revision)).rejects.toThrow("面板禁止覆盖");
    await expect(r.store.restore(MODEL, before.revision)).rejects.toThrow("面板禁止覆盖");
    await fs.writeFile(r.file(), Buffer.from([0xff]));
    await expect(r.store.read(MODEL)).rejects.toThrow("UTF-8");
    await fs.writeFile(r.file(), Buffer.alloc(256 * 1024 + 1));
    await expect(r.store.read(MODEL)).rejects.toThrow("过大");
  });

  it("目录暂不可用时恢复失败保留编辑文件", async () => {
    const r = await rig({ template: "默认" }), before = (await r.store.read(MODEL))!;
    await fs.rm(path.join(r.codexHome, "models_cache.json"));
    await expect(r.store.restore(MODEL, before.revision)).rejects.toThrow("目录模板暂不可用");
    expect(await fs.readFile(r.file(), "utf8")).toBe("默认");
  });

  it("拒绝链接目录、非普通文件，不写入目录之外", async () => {
    const r = await rig({ template: "默认" });
    await fs.mkdir(path.join(r.dir, "prompts"));
    const outside = path.join(r.dir, "outside"); await fs.mkdir(outside);
    await fs.symlink(outside, path.join(r.dir, "prompts", "codex-base"), "junction");
    await expect(r.store.prepare(MODEL)).rejects.toThrow("目录不可为链接");
    expect(await fs.readdir(outside)).toEqual([]);
    await fs.unlink(path.join(r.dir, "prompts", "codex-base"));
    await fs.mkdir(r.file(), { recursive: true });
    await expect(r.store.read(MODEL)).rejects.toThrow("不是普通文件");
  });

  it("并发首次使用不会覆盖已播种的文件", async () => {
    const r = await rig({ template: "默认" });
    const second = new CodexBasePromptStore({ dataDir: r.dir, codexHome: r.codexHome, containsSecret: () => false });
    const snapshots = await Promise.all([r.store.read(MODEL), second.read(MODEL)]);
    expect(snapshots.map(s => s!.custom)).toEqual(["默认", "默认"]);
    expect(await fs.readdir(path.dirname(r.file()))).toEqual([basePromptFilename(MODEL)]);
  });
});

describe("安全文件名", () => {
  it("常用 slug 简洁，分隔符、下划线和大小写不会互相覆盖", () => {
    expect(basePromptFilename(MODEL)).toBe("codex__gpt-6.1-sol.md");
    const names = ["a/b", "a__b", "a_b", "A/b", "a/B"].map(basePromptFilename);
    expect(new Set(names.map(n => n.toLowerCase())).size).toBe(names.length);
  });
  it.each(["", ".", "..", "../x", "a/../b", "a/./b", "/a", "a/", "a//b", "a\\b", "a:b", "a\"b", "a\nb", "a b", "a..b", "a.", "CON", "aux.txt", "a/NUL", "x".repeat(201)])(
    "拒绝不安全 slug %j", slug => expect(() => basePromptFilename(slug)).toThrow());
});

describe("Codex 调用基础指令", () => {
  it("新建、恢复、丢失线程回退均按加载时的模型使用同一生效文件（thread/start、thread/resume 的 model_instructions_file）", async () => {
    const r = await rig({ template: "启动模型模板" });
    await r.store.prepare(MODEL);
    await r.cache("票据模型模板", OTHER);
    const expected = path.join(r.codexHome, "base-instructions", basePromptFilename(OTHER));
    await r.runner.openThread("owner", { mcpEnv: {}, model: OTHER });
    await r.runner.openThread("owner", { mcpEnv: {}, model: OTHER });
    await fs.writeFile(r.runner.opts.threadsFile, JSON.stringify({ owner: { thread_id: "missing-thread" } }), "utf8");
    r.missing.thread = "missing-thread";
    await r.runner.openThread("owner", { mcpEnv: {}, model: OTHER });
    const loads = r.loads();
    expect(loads.map(l => l.threadId ?? "new")).toEqual(["new", "base-thread", "missing-thread", "new"]);
    for (const load of loads) expect(load).toMatchObject({ model: OTHER, config: { model_instructions_file: expected } });
    expect(await fs.readFile(expected, "utf8")).toBe(`票据模型模板\n\n${MANAGED_QQ_INSTRUCTIONS}`);
  });

  it("未指定模型时用默认模型的基础指令；没有模板时省略覆盖", async () => {
    const r = await rig({ template: "默认模板" });
    await r.runner.openThread("owner", { mcpEnv: {} });
    expect(r.loads()[0]!.config.model_instructions_file).toBe(path.join(r.codexHome, "base-instructions", basePromptFilename(MODEL)));
    await r.runner.openThread("group:1", { mcpEnv: {}, model: OTHER });
    expect(r.loads()[1]!.config).not.toHaveProperty("model_instructions_file");
  });

  it("文件路径原样作为 config 值传入（JSON，不经 TOML 转义），只有一项", async () => {
    const r = await rig();
    const file = 'C:\\目录\\quote"name\nbase.md';
    r.runner.opts.prepareBasePrompt = async () => file;
    await r.runner.openThread("owner", { mcpEnv: {}, model: MODEL });
    const config = r.loads()[0]!.config;
    expect(config.model_instructions_file).toBe(file);
    expect(Object.keys(config).filter(k => k.includes("instructions"))).toEqual(["model_instructions_file"]);
  });
});

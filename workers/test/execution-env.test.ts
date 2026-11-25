import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it, vi } from "vitest";
import { workspaceExecutionEnv, type WorkspaceFiles } from "../src/sandbox/execution-env";
import { ObjectFiles } from "../src/sandbox/object-files";
import { FILE_MAX_BYTES } from "../src/media/model";

const context = BACKGROUND_CONTEXT;
function fixture() {
  const bytes = new TextEncoder().encode("\uFEFF中文\r\n第二行\n"), contents = new Map([["/work/out/note.txt", bytes]]);
  const files: WorkspaceFiles = {
    readBlob: vi.fn(async path => { const bytes = contents.get(path); if (!bytes) throw Error("not_found"); return { bytes, name: "note.txt", mime: "text/plain" }; }),
    writeFile: vi.fn(async (path, data) => { const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data; contents.set(path, bytes); return { bytes: bytes.length }; }),
    readObject: vi.fn(async key => { const data = contents.get(key); if (!data) throw Error("not_found"); return data; }),
    writeObject: vi.fn(async (key, content) => { const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content; contents.set(key, bytes); return { bytes: bytes.length }; }),
    createOutputPrefix: vi.fn(async () => "r2://.codemode/test"),
  };
  let allowed = true;
  const environment = workspaceExecutionEnv({ id: "test", cwd: "/work/out", files: async () => { if (!allowed) throw Error("permission_denied"); return files; } });
  return { files, contents, bytes, environment, revoke: () => { allowed = false; } };
}
describe("Code Mode 文件环境", () => {
  it("超限文件保留 too_large 原因，尚未写入文件后端", async () => {
    const f = fixture();
    const result = await f.environment.writeFile("large.bin", new Uint8Array(FILE_MAX_BYTES + 1), context);
    expect(result).toMatchObject({ ok: false, error: { code: "unknown", message: "too_large" } });
    expect(f.files.writeFile).not.toHaveBeenCalled();
  });
  it("按工作目录读取、保留 BOM 和换行，支持二进制与临时文件，关闭不删产物", async () => {
    const f = fixture(), api = f.environment;
    expect(await api.readBinaryFile("note.txt", context)).toEqual({ ok: true, value: f.bytes });
    expect(await api.readTextFile("note.txt", context)).toEqual({ ok: true, value: "\uFEFF中文\r\n第二行\n" });
    expect(await api.readTextLines("note.txt", { maxLines: 1 }, context)).toEqual({ ok: true, value: ["\uFEFF中文"] });
    expect(await api.writeFile("raw.bin", new Uint8Array([0, 255]), context)).toEqual({ ok: true, value: undefined });
    expect(f.contents.get("/work/out/raw.bin")).toEqual(new Uint8Array([0, 255]));
    expect(await api.createTempFile({ prefix: "test-", suffix: ".png" }, context)).toEqual({ ok: true, value: "r2://.codemode/test/output.png" });
    await api.cleanup(context);
    expect(f.contents.has("r2://.codemode/test/output.png")).toBe(true);
    expect(await api.exec("pwd", {}, context)).toMatchObject({ ok: false, error: { code: "shell_unavailable" } });
  });
  it("逐次授权，拒绝越界路径，返回真实的读取和保存失败", async () => {
    const f = fixture(), api = f.environment;
    expect(await api.readBinaryFile("absent", context)).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await api.writeFile("../../outside", "x", context)).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    expect(f.files.writeFile).not.toHaveBeenCalled();
    vi.mocked(f.files.writeFile).mockRejectedValueOnce(Error("persistence_failed"));
    expect(await api.writeFile("valid", "x", context)).toMatchObject({ ok: false, error: { message: "persistence_failed" } });
    f.revoke();
    expect(await api.createTempDir("test", context)).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    expect(await api.readBinaryFile("note.txt", context)).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    expect(f.files.createOutputPrefix).not.toHaveBeenCalled();
  });
  it("R2 临时存储范围只包含本资源超过七天的工具输出", async () => {
    const now = Date.now(), prefix = "scope/.codemode/";
    const bucket = { list: vi.fn(async () => ({ objects: [
      { key: prefix + "old/image", uploaded: new Date(now - 8 * 86400_000) },
      { key: prefix + "new/image", uploaded: new Date(now) },
    ] })), delete: vi.fn(async () => {}) };
    const files = new ObjectFiles(bucket as unknown as R2Bucket, "scope/");
    expect(files.outputPrefix("pi-codemode-")).toMatch(/^r2:\/\/\.codemode\//);
    await files.cleanupOutputs(now);
    expect(bucket.list).toHaveBeenCalledWith({ prefix, limit: 100 });
    expect(bucket.delete).toHaveBeenCalledWith([prefix + "old/image"]);
  });
});

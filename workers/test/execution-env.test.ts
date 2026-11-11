import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it, vi } from "vitest";
import { workspaceExecutionEnv, type WorkspaceFiles } from "../src/sandbox/execution-env";
import { createOutputDirectory, OUTPUT_ROOT, OUTPUT_RETENTION_MS } from "../src/sandbox/output-directory";
import { FILE_MAX_BYTES } from "../src/media/model";

const context = BACKGROUND_CONTEXT;
function fixture() {
  const bytes = new TextEncoder().encode("\uFEFF中文\r\n第二行\n"), contents = new Map([["/work/out/note.txt", bytes]]);
  const files: WorkspaceFiles = {
    readBlob: vi.fn(async path => { const bytes = contents.get(path); if (!bytes) throw Error("not_found"); return { bytes, name: "note.txt", mime: "text/plain" }; }),
    writeFile: vi.fn(async (path, data) => { const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data; contents.set(path, bytes); return { bytes: bytes.length }; }),
    createTempDir: vi.fn(async () => "/work/.codemode/test"),
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
  it("共享工作区并发创建输出时，已被另一调用清理的目录不阻止新输出", async () => {
    const now = 1800000000000, expired = `${now - OUTPUT_RETENTION_MS - 1}-00000000-0000-4000-8000-000000000000-output-`;
    let removed = false;
    const files = {
      list: async () => [{ name: expired, type: "dir" as const, size: 0 }],
      remove: vi.fn(async (_path: string) => { if (removed) throw Error("not_found"); removed = true; }),
      mkdir: vi.fn(async (_path: string) => {}),
    };
    const paths = await Promise.all([createOutputDirectory(files, "output-", now), createOutputDirectory(files, "output-", now)]);
    expect(new Set(paths).size).toBe(2);
    expect(files.remove).toHaveBeenCalledTimes(2);
    expect(files.mkdir.mock.calls.map(call => call[0]).sort()).toEqual(paths.sort());
  });
  it.each(["permission_denied", "persistence_failed"])("目录清理的 %s 不能冒充成功", async code => {
    const now = 1800000000000;
    const files = {
      list: async () => [{ name: `${now - OUTPUT_RETENTION_MS - 1}-00000000-0000-4000-8000-000000000000-output-`, type: "dir" as const, size: 0 }],
      remove: async () => { throw Error(code); }, mkdir: vi.fn(async () => {}),
    };
    await expect(createOutputDirectory(files, "output-", now)).rejects.toThrow(code);
    expect(files.mkdir).not.toHaveBeenCalled();
  });
  it("按工作目录读取、保留 BOM 和换行，支持二进制与临时文件，关闭不删产物", async () => {
    const f = fixture(), api = f.environment;
    expect(await api.readBinaryFile("note.txt", context)).toEqual({ ok: true, value: f.bytes });
    expect(await api.readTextFile("note.txt", context)).toEqual({ ok: true, value: "\uFEFF中文\r\n第二行\n" });
    expect(await api.readTextLines("note.txt", { maxLines: 1 }, context)).toEqual({ ok: true, value: ["\uFEFF中文"] });
    expect(await api.writeFile("raw.bin", new Uint8Array([0, 255]), context)).toEqual({ ok: true, value: undefined });
    expect(f.contents.get("/work/out/raw.bin")).toEqual(new Uint8Array([0, 255]));
    expect(await api.createTempFile({ prefix: "test-", suffix: ".png" }, context)).toEqual({ ok: true, value: "/work/.codemode/test/output.png" });
    await api.cleanup(context);
    expect(f.contents.has("/work/.codemode/test/output.png")).toBe(true);
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
    expect(f.files.createTempDir).not.toHaveBeenCalled();
  });
  it("清理仅限已过期的受管目录，每次至多十个，不碰链接、普通目录和新输出", async () => {
    const now = 1800000000000, uuid = "00000000-0000-4000-8000-000000000000";
    const expired = Array.from({ length: 12 }, (_, i) => ({ name: `${now - OUTPUT_RETENTION_MS - 100 + i}-${uuid}-pi-codemode-`, type: "dir" as const, size: 0 }));
    const files = {
      list: vi.fn(async () => [...expired, { name: "notes", type: "dir" as const, size: 0 }, { ...expired[0]!, name: `${now}-${uuid}-output-` }, { ...expired[0]!, type: "link" as const }]),
      mkdir: vi.fn(async (_path: string) => {}), remove: vi.fn(async (_path: string) => {}),
    };
    expect(await createOutputDirectory(files, "pi-codemode-", now)).toMatch(new RegExp(`^${OUTPUT_ROOT}/${now}-[a-f0-9-]+-pi-codemode-$`));
    expect(files.remove.mock.calls.map(call => call[0])).toEqual(expired.slice(0, 10).map(entry => `${OUTPUT_ROOT}/${entry.name}`));
    await expect(createOutputDirectory(files, "../escape", now)).rejects.toThrow("invalid_request");
    expect(files.mkdir).toHaveBeenCalledTimes(1);
  });
});

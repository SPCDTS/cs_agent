// /work 的二进制快照与两阶段恢复；持久化与权限仍由 SandboxDO 负责。
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
export const FILE_LIMIT = 10 * 1024 * 1024, WORKSPACE_LIMIT = 50 * 1024 * 1024, FILE_COUNT_LIMIT = 20000;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
function fail(code, issues) { throw Object.assign(new Error(code), { workspaceFailure: true, status: 400, issues }); }
export function relativePath(raw) {
  if (typeof raw !== "string" || !raw || raw.length > 1024 || raw.includes("\\") || raw.includes("\0") || raw.startsWith("/") || raw.split("/").some(part => !part || part === "." || part === "..")) fail("path_denied");
  return raw;
}
export function detectImage(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a/.test(bytes.subarray(0,6).toString("latin1"))) return "image/gif";
  if (bytes.subarray(0,4).toString("latin1") === "RIFF" && bytes.subarray(8,12).toString("latin1") === "WEBP") return "image/webp";
}
export function workspaceControl({ root, own }) {
  let restore;
  async function scan() {
    const files = [], directories = [], issues = [];
    let totalBytes = 0;
    async function walk(dir, prefix = "") {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
        const relative = prefix + entry.name, absolute = path.join(dir, entry.name);
        const stat = await fs.lstat(absolute);
        if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) { issues.push({ path: relative, code: "unsupported_link_or_special" }); continue; }
        try { relativePath(relative); } catch { issues.push({ path: relative, code: "path_denied" }); continue; }
        if (stat.isDirectory()) { directories.push(relative); await walk(absolute, relative + "/"); continue; }
        totalBytes += stat.size;
        if (stat.size > FILE_LIMIT) { issues.push({ path: relative, code: "file_too_large", bytes: stat.size }); continue; }
        if (files.length >= FILE_COUNT_LIMIT) { issues.push({ path: relative, code: "too_many_files", bytes: stat.size }); continue; }
        const bytes = await fs.readFile(absolute);
        if (bytes.length !== stat.size) { issues.push({ path: relative, code: "file_changed_during_snapshot" }); continue; }
        files.push({ path: relative, bytes: bytes.length, sha256: digest(bytes), mime: detectImage(bytes) ?? "application/octet-stream", mode: stat.mode & 0o777 });
      }
    }
    await walk(root);
    if (totalBytes > WORKSPACE_LIMIT) issues.push({ path: ".", code: "workspace_too_large", bytes: totalBytes });
    if (directories.length > FILE_COUNT_LIMIT) issues.push({ path: ".", code: "too_many_directories" });
    if (issues.length) fail("workspace_quota", issues);
    return { files, directories, totalBytes };
  }
  async function start(manifest) {
    if (!manifest || !Array.isArray(manifest.files) || !Array.isArray(manifest.directories) || manifest.files.length > FILE_COUNT_LIMIT || manifest.directories.length > FILE_COUNT_LIMIT) fail("invalid_request");
    const paths = new Set();
    let size = 0;
    for (const file of manifest.files) {
      relativePath(file.path);
      if (paths.has(file.path) || !Number.isInteger(file.bytes) || file.bytes < 0 || file.bytes > FILE_LIMIT || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777) fail("invalid_request");
      paths.add(file.path); size += file.bytes;
    }
    for (const dir of manifest.directories) { relativePath(dir); if (paths.has(dir)) fail("invalid_request"); paths.add(dir); }
    if (size > WORKSPACE_LIMIT) fail("workspace_quota", [{ path: ".", code: "workspace_too_large", bytes: size }]);
    if (restore) await fs.rm(restore.stage, { recursive: true, force: true });
    const stage = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-restore-"));
    restore = { id: randomUUID(), stage, manifest, received: new Set() };
    for (const dir of manifest.directories) await fs.mkdir(path.join(stage, dir), { recursive: true });
    return { id: restore.id };
  }
  function current(id) { if (!restore || restore.id !== id) fail("invalid_request"); return restore; }
  async function put(id, raw, bytes) {
    const state = current(id), relative = relativePath(raw), file = state.manifest.files.find(file => file.path === relative);
    if (!file || bytes.length !== file.bytes || digest(bytes) !== file.sha256) fail("blob_corrupt");
    const absolute = path.join(state.stage, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, bytes, { mode: file.mode });
    state.received.add(relative);
    return { bytes: bytes.length };
  }
  async function commit(id) {
    const state = current(id);
    if (state.received.size !== state.manifest.files.length) fail("restore_incomplete");
    // 先完成所有校验与写入，再替换临时物化视图。中断后由 DO 从同一已提交 manifest 重试恢复。
    for (const entry of await fs.readdir(root)) await fs.rm(path.join(root, entry), { recursive: true, force: true });
    for (const entry of await fs.readdir(state.stage)) await fs.rename(path.join(state.stage, entry), path.join(root, entry));
    async function ownership(dir) {
      await own(dir);
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) await ownership(absolute); else await own(absolute);
      }
    }
    await ownership(root);
    await fs.rm(state.stage, { recursive: true, force: true });
    restore = undefined;
    return { restored: true };
  }
  return { scan, start, put, commit };
}

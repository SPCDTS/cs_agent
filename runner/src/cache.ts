import { promises as fs } from "node:fs";
import path from "node:path";
import { exists, inside, removeInside, sha256 } from "./files.ts";

/** 缓存只接受已停止 guest 的普通文件，按工作区和平台隔离；不包含宿主用户的 npm 配置或凭据。 */
export class NpmCache {
  readonly root: string;
  readonly maxEntryBytes: number;
  readonly maxTotalBytes: number;
  constructor(root: string, maxEntryBytes = 512 * 1024 * 1024, maxTotalBytes = 2 * 1024 * 1024 * 1024) {
    this.root = path.resolve(root); this.maxEntryBytes = maxEntryBytes; this.maxTotalBytes = maxTotalBytes;
  }
  key(workspace: string, node: string) { return sha256(JSON.stringify({ workspace, os: "windows", arch: process.arch, node })); }
  private async copy(source: string, target: string) {
    let bytes = 0, entries = 0;
    await fs.mkdir(target, { recursive: true });
    const visit = async (relative: string) => {
      const directory = relative ? inside(source, relative) : source;
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("cache_link_denied");
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (++entries > 100000) throw new Error("cache_quota");
        const name = relative ? relative + "/" + entry.name : entry.name, from = inside(source, name), to = inside(target, name);
        const stat = await fs.lstat(from);
        if (stat.isSymbolicLink() || path.resolve(await fs.realpath(from)) !== path.resolve(from)) throw new Error("cache_link_denied");
        if (stat.isDirectory()) { await fs.mkdir(to, { recursive: true }); await visit(name); }
        else if (stat.isFile()) { bytes += stat.size; if (bytes > this.maxEntryBytes) throw new Error("cache_quota"); await fs.copyFile(from, to); }
        else throw new Error("cache_link_denied");
      }
    };
    await visit(""); return bytes;
  }
  async seed(key: string, destination: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("invalid_cache_key");
    await fs.mkdir(destination, { recursive: true });
    const source = path.join(this.root, key, "_cacache");
    if (await exists(source)) { await this.copy(source, path.join(destination, "_cacache")); await fs.utimes(path.join(this.root, key), new Date(), new Date()); return true; }
    return false;
  }
  async promote(key: string, source: string, verify: (cache: string) => Promise<void>) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("invalid_cache_key");
    const content = path.join(source, "_cacache"); if (!await exists(content)) return;
    await fs.mkdir(this.root, { recursive: true });
    const stage = path.join(this.root, key + ".staging"), target = path.join(this.root, key);
    await removeInside(this.root, stage);
    try {
      const bytes = await this.copy(content, path.join(stage, "_cacache"));
      await verify(stage);
      await fs.writeFile(path.join(stage, "size.json"), JSON.stringify({ bytes }), "utf8");
      await removeInside(this.root, target); await fs.rename(stage, target); await this.evict();
    } catch (error) { await removeInside(this.root, stage); throw error; }
  }
  private async evict() {
    const entries = [];
    for (const entry of await fs.readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const name = path.join(this.root, entry.name), size: unknown = JSON.parse(await fs.readFile(path.join(name, "size.json"), "utf8"));
      if (!size || typeof size !== "object" || !("bytes" in size) || typeof size.bytes !== "number") throw new Error("cache_metadata_invalid");
      entries.push({ name, bytes: size.bytes, used: (await fs.stat(name)).mtimeMs });
    }
    let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of entries.sort((a, b) => a.used - b.used)) { if (total <= this.maxTotalBytes) break; await removeInside(this.root, entry.name); total -= entry.bytes; }
  }
}

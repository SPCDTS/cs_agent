import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { unzipSync, zipSync } from "fflate";
import { SkillsLoader, parseSkillFrontmatter, validateSkill } from "./pi-tools/skills.js";

const MD_BYTES = 256 * 1024;
export interface SkillEntry {
  name: string; dir: string; description?: string; files: number; bytes: number;
  diagnostics: string[]; hidden: boolean; mtime: number;
}
export interface SkillFile { path: string; size: number }
export interface SkillImportResult { imported: string[]; skipped: { path: string; reason: string }[] }
export class SkillsStoreError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const inside = (root: string, file: string) => {
  const rel = path.relative(root, file);
  return !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + path.sep);
};
const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

/** 复用加载器的名称规则；管理入口不能像提示词加载器一样仅告警后继续。 */
function validName(name: string): void {
  const result = validateSkill(name, { description: "名称校验" });
  if ("error" in result || result.warnings.length) throw new SkillsStoreError(400, "非法技能名称");
}
function decode(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new SkillsStoreError(400, "SKILL.md 必须是 UTF-8 文本"); }
}
function metadata(bytes: Uint8Array, dirName?: string) {
  if (bytes.length > MD_BYTES) throw new SkillsStoreError(413, "SKILL.md 超过 256 KiB");
  const parsed = parseSkillFrontmatter(decode(bytes));
  if (!parsed) throw new SkillsStoreError(400, "缺少 frontmatter");
  const result = validateSkill(dirName ?? "", parsed.fields);
  if ("error" in result) throw new SkillsStoreError(400, result.error);
  validName(result.name);
  if (result.warnings.length) throw new SkillsStoreError(400, result.warnings.join("；"));
  if (dirName !== undefined && result.name !== dirName) throw new SkillsStoreError(400, "目录名必须等于 name");
  return result;
}

/** ZIP 使用跨平台路径子集，避免 Windows 盘符、ADS、设备名及大小写别名。 */
function zipPath(file: string): string {
  if (!file || file.startsWith("/") || file.includes("..") || /[\\:\x00-\x1f\x7f]/.test(file)) {
    throw new SkillsStoreError(400, "非法 ZIP 路径：" + file);
  }
  const name = file.endsWith("/") ? file.slice(0, -1) : file;
  if (name.split("/").some(part => !part || part === "." || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new SkillsStoreError(400, "非法 ZIP 路径：" + file);
  }
  return name;
}

export class SkillsStore {
  private readonly dir: string;
  private readonly loader: SkillsLoader;
  private readonly limits: { maxZipBytes: number; maxFileBytes: number; maxEntries: number };
  private pending: Promise<unknown> = Promise.resolve();

  constructor(opts: { dir: string; loader: SkillsLoader; limits?: { maxZipBytes?: number; maxFileBytes?: number; maxEntries?: number } }) {
    this.dir = path.resolve(opts.dir);
    this.loader = opts.loader;
    this.limits = { maxZipBytes: 20 * 1024 * 1024, maxFileBytes: 5 * 1024 * 1024, maxEntries: 500, ...opts.limits };
    if (Object.values(this.limits).some(n => !Number.isSafeInteger(n) || n <= 0)) throw new Error("技能限额必须是正整数");
  }

  private mutate<T>(run: () => Promise<T>): Promise<T> {
    const result = this.pending.then(run);
    this.pending = result.catch(() => undefined);
    return result;
  }

  private async root(create = false): Promise<boolean> {
    if (create) {
      let parent = this.dir;
      while (!await fs.lstat(parent).catch(error => { if (missing(error)) return undefined; throw error; })) parent = path.dirname(parent);
      if (!samePath(await fs.realpath(parent), parent)) throw new SkillsStoreError(400, "技能根目录及上级目录不可为链接");
      await fs.mkdir(this.dir, { recursive: true });
    }
    const st = await fs.lstat(this.dir).catch(error => { if (missing(error)) return undefined; throw error; });
    if (!st) return false;
    if (!st.isDirectory() || st.isSymbolicLink() || !samePath(await fs.realpath(this.dir), this.dir)) {
      throw new SkillsStoreError(400, "技能根目录及上级目录不可为链接");
    }
    return true;
  }

  private async directory(name: string): Promise<string> {
    validName(name);
    if (!await this.root()) throw new SkillsStoreError(404, "技能不存在");
    const dir = path.join(this.dir, name);
    const st = await fs.lstat(dir).catch(error => { if (missing(error)) throw new SkillsStoreError(404, "技能不存在"); throw error; });
    if (!st.isDirectory() || st.isSymbolicLink()) throw new SkillsStoreError(400, "技能目录不可为链接或普通文件");
    return dir;
  }

  private async walk(dir: string, directory?: (relative: string) => void): Promise<SkillFile[]> {
    const files: SkillFile[] = [];
    const visit = async (current: string): Promise<void> => {
      for (const name of (await fs.readdir(current)).sort()) {
        if (name.startsWith(".tmp-")) continue;
        const file = path.join(current, name), st = await fs.lstat(file);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) { directory?.(path.relative(dir, file).split(path.sep).join("/")); await visit(file); }
        else if (st.isFile()) files.push({ path: path.relative(dir, file).split(path.sep).join("/"), size: st.size });
      }
    };
    await visit(dir);
    return files;
  }

  async list(): Promise<SkillEntry[]> {
    if (!await this.root()) return [];
    const loaded = await this.loader.load(), result: SkillEntry[] = [];
    for (const name of (await fs.readdir(this.dir)).sort()) {
      if (name.startsWith(".")) continue;
      const dir = path.join(this.dir, name), st = await fs.lstat(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      const skill = loaded.skills.find(s => samePath(s.dir, dir));
      const diagnostics = loaded.diagnostics.filter(d => inside(dir, d.path)).map(d => d.reason);
      try { validName(name); } catch { diagnostics.push("非法技能名称"); }
      if (skill && skill.name !== name) diagnostics.push("目录名必须等于 name");
      if (!await fs.lstat(path.join(dir, "SKILL.md")).catch(error => { if (missing(error)) return undefined; throw error; })) diagnostics.push("缺少 SKILL.md");
      const files = await this.walk(dir);
      result.push({ name, dir, description: skill?.description, files: files.length, bytes: files.reduce((sum, f) => sum + f.size, 0),
        diagnostics: [...new Set(diagnostics)], hidden: skill?.hidden ?? false, mtime: st.mtimeMs });
    }
    return result;
  }

  async files(name: string): Promise<SkillFile[]> { return this.walk(await this.directory(name)); }

  async readSkillMd(name: string): Promise<string> {
    const file = path.join(await this.directory(name), "SKILL.md");
    const st = await fs.lstat(file).catch(error => { if (missing(error)) throw new SkillsStoreError(404, "缺少 SKILL.md"); throw error; });
    if (!st.isFile() || st.isSymbolicLink()) throw new SkillsStoreError(400, "SKILL.md 必须是普通文件");
    if (st.size > MD_BYTES) throw new SkillsStoreError(413, "SKILL.md 超过 256 KiB");
    const bytes = await fs.readFile(file);
    if (bytes.length > MD_BYTES) throw new SkillsStoreError(413, "SKILL.md 超过 256 KiB");
    return decode(bytes);
  }

  private async install(name: string, files: Record<string, Uint8Array>, overwrite: boolean): Promise<boolean> {
    validName(name);
    await this.root(true);
    const target = path.join(this.dir, name);
    const old = await fs.lstat(target).catch(error => { if (missing(error)) return undefined; throw error; });
    if (old?.isSymbolicLink() || (old && !old.isDirectory())) throw new SkillsStoreError(400, "技能目标不可为链接或普通文件");
    if (old && !overwrite) return false;
    const tmp = await fs.mkdtemp(path.join(this.dir, ".tmp-"));
    const backup = path.join(this.dir, ".tmp-old-" + randomUUID());
    let moved = false;
    try {
      for (const [relative, bytes] of Object.entries(files)) {
        const file = path.join(tmp, zipPath(relative));
        if (!inside(tmp, file)) throw new SkillsStoreError(400, "文件超出技能目录");
        await fs.mkdir(path.dirname(file), { recursive: true });
        if (relative.endsWith("/")) await fs.mkdir(file, { recursive: true });
        else await fs.writeFile(file, bytes, { flag: "wx" });
      }
      if (old) { await fs.rename(target, backup); moved = true; }
      try { await fs.rename(tmp, target); }
      catch (error) { if (moved) { await fs.rename(backup, target); moved = false; } throw error; }
      if (moved) await fs.rm(backup, { recursive: true, force: true });
      return true;
    } finally { await fs.rm(tmp, { recursive: true, force: true }); }
  }

  importSkillMd(text: string, opts: { overwrite: boolean }): Promise<{ name: string }> {
    return this.mutate(async () => {
      const bytes = Buffer.from(text, "utf8"), { name } = metadata(bytes);
      if (bytes.length > this.limits.maxFileBytes || bytes.length > this.limits.maxZipBytes) throw new SkillsStoreError(413, "文件超过技能限额");
      if (!await this.install(name, { "SKILL.md": bytes }, opts.overwrite)) throw new SkillsStoreError(409, "技能已存在，请勾选覆盖");
      return { name };
    });
  }

  importZip(bytes: Uint8Array, opts: { overwrite: boolean }): Promise<SkillImportResult> {
    return this.mutate(async () => {
      if (bytes.length > this.limits.maxZipBytes) throw new SkillsStoreError(413, "ZIP 超过大小上限");
      if (bytes.length < 4 || bytes[0] !== 80 || bytes[1] !== 75 || bytes[2] !== 3 || bytes[3] !== 4) throw new SkillsStoreError(400, "无效 ZIP 文件");
      const seen = new Set<string>();
      let count = 0, total = 0, files: Record<string, Uint8Array>;
      try {
        files = unzipSync(bytes, { filter: entry => {
          const name = zipPath(entry.name), key = name.toLowerCase();
          if (seen.has(key)) throw new SkillsStoreError(400, "ZIP 含重复或大小写冲突路径");
          seen.add(key);
          // 解压分配内存之前检查中央目录声明的大小；解压后再核对实际大小。
          if (++count > this.limits.maxEntries) throw new SkillsStoreError(413, "ZIP 条目数超过上限");
          total += entry.originalSize;
          if (entry.originalSize > this.limits.maxFileBytes || total > this.limits.maxZipBytes) throw new SkillsStoreError(413, "ZIP 解压大小超过上限");
          return !name.split("/").some(p => p === "__MACOSX" || p === ".DS_Store");
        } });
      } catch (error) { if (error instanceof SkillsStoreError) throw error; throw new SkillsStoreError(400, "无法解析 ZIP 文件"); }
      total = 0;
      for (const data of Object.values(files)) {
        total += data.length;
        if (data.length > this.limits.maxFileBytes || total > this.limits.maxZipBytes) throw new SkillsStoreError(413, "ZIP 解压大小超过上限");
      }
      // fflate 不暴露外部属性：尾部 / 视为目录，其余只写普通文件，永不创建链接。
      const paths = Object.keys(files).sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
      const regular = new Set(paths.filter(file => !file.endsWith("/")).map(file => file.toLowerCase()));
      for (const file of paths) {
        const parts = file.replace(/\/$/, "").split("/");
        for (let i = 1; i < parts.length; i++) if (regular.has(parts.slice(0, i).join("/").toLowerCase())) {
          throw new SkillsStoreError(400, "ZIP 文件与目录路径冲突");
        }
      }
      const roots: string[] = [];
      for (const file of paths) if (path.posix.basename(file) === "SKILL.md" && !file.endsWith("/") && !roots.some(root => file.startsWith(root))) {
        roots.push(file.slice(0, -"SKILL.md".length));
      }
      const result: SkillImportResult = { imported: [], skipped: [] };
      const imported = new Set<string>();
      for (const root of roots) {
        try {
          const { name } = metadata(files[root + "SKILL.md"], root ? path.posix.basename(root.slice(0, -1)) : undefined);
          if (imported.has(name)) throw new SkillsStoreError(400, "ZIP 内技能名称重复");
          const entries = Object.fromEntries(paths.filter(file => file.startsWith(root) && file !== root).map(file => [file.slice(root.length), files[file]]));
          if (!await this.install(name, entries, opts.overwrite)) throw new SkillsStoreError(409, "技能已存在，未覆盖");
          imported.add(name); result.imported.push(name);
        } catch (error) {
          if (!(error instanceof SkillsStoreError)) throw error;
          result.skipped.push({ path: root.replace(/\/$/, "") || "SKILL.md", reason: error.message });
        }
      }
      const unmatched = new Set(paths.filter(file => !roots.some(root => file.startsWith(root) || root.startsWith(file.endsWith("/") ? file : file + "/"))).map(file => file.split("/")[0]));
      for (const name of unmatched) result.skipped.push({ path: name, reason: "缺少 SKILL.md" });
      if (!roots.length && !unmatched.size) result.skipped.push({ path: "ZIP", reason: "缺少 SKILL.md" });
      return result;
    });
  }

  async exportZip(name: string): Promise<Uint8Array> {
    const dir = await this.directory(name), files: Record<string, Uint8Array> = Object.create(null);
    files[name + "/"] = new Uint8Array();
    for (const file of await this.walk(dir, relative => { files[`${name}/${relative}/`] = new Uint8Array(); })) {
      files[`${name}/${file.path}`] = await fs.readFile(path.join(dir, file.path));
    }
    return zipSync(files);
  }

  remove(name: string): Promise<void> {
    return this.mutate(async () => {
      const dir = await this.directory(name), tmp = path.join(this.dir, ".tmp-del-" + randomUUID());
      await fs.rename(dir, tmp);
      await fs.rm(tmp, { recursive: true, force: true });
    });
  }
}

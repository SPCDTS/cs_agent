/**
 * 核心画像（docs/MEMORY-DESIGN.md §4.4）：每个命名空间一个 `${DATA_DIR}/memory/<ns>/profile.md`（ns 中的冒号换下划线，
 * 与工作区目录同一写法），纯文本，≤4 KiB。revision = mtime + size + 内容哈希，写入必须带读到的 revision，不符即拒绝（CAS）。
 * 写入前过与提示词编辑器相同的秘密检测（shared/redact 的 containsSecret）。不认识权限。
 */
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { containsSecret } from "../../shared/redact.js";
import { PROFILE_MAX_BYTES, isMemoryNs } from "./types.js";

/** 文件不存在时的 revision；首次创建画像须带它。 */
export const PROFILE_NONE = "none";
const READ_MAX_BYTES = 64 * 1024;

export interface ProfileSnapshot {
  ns: string; text: string; revision: string; file: string; updatedAt: number | null;
  /** 超过 4 KiB（运维手改）：不进入提示，需要重写 */
  oversize?: true;
}

export class ProfileError extends Error {
  constructor(message: string, readonly code: "invalid" | "stale" | "secret" = "invalid") {
    super(message);
    this.name = "ProfileError";
  }
}

export const profileDirName = (ns: string) => ns.replace(/:/g, "_");

const revisionOf = (mtimeMs: number, bytes: Uint8Array) =>
  createHash("sha256").update(`${mtimeMs}:${bytes.length}:`).update(bytes).digest("hex").slice(0, 24);

export class ProfileStore {
  readonly root: string;
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(dataDir: string) {
    this.root = path.join(dataDir, "memory");
  }

  file(ns: string): string {
    if (!isMemoryNs(ns)) throw new ProfileError("命名空间无效");
    return path.join(this.root, profileDirName(ns), "profile.md");
  }

  /**
   * 现读画像；不存在为空文本、revision 为 none。画像根目录、命名空间目录与文件都不能是链接（含 Windows junction），
   * 文件的真实路径须在画像根目录之下，打开后再按描述符核对一次是普通文件——否则一个指向别的命名空间的目录链接
   * 就能把 owner 画像注入群提示。超过 4 KiB 的画像（运维手改）标 oversize：不进入提示，revision 照常给出以便重写。
   */
  async read(ns: string): Promise<ProfileSnapshot> {
    const file = this.file(ns), dir = path.dirname(file);
    const empty = { ns, text: "", revision: PROFILE_NONE, file, updatedAt: null };
    let handle: fs.FileHandle;
    try {
      for (const d of [this.root, dir]) {
        const st = await fs.lstat(d);
        if (!st.isDirectory() || st.isSymbolicLink()) throw new ProfileError("画像目录不可为链接");
      }
      const st = await fs.lstat(file);
      if (!st.isFile() || st.isSymbolicLink()) throw new ProfileError("profile.md 不是普通文件");
      if (st.size > READ_MAX_BYTES) throw new ProfileError("profile.md 过大，无法安全读取");
      const [real, root] = await Promise.all([fs.realpath(file), fs.realpath(this.root)]);
      const rel = path.relative(root, real);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || real !== path.join(root, profileDirName(ns), "profile.md"))
        throw new ProfileError("profile.md 不在画像目录内");
      handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty;
      throw error;
    }
    // 同一文件描述符读取内容与时间戳，避免原子替换导致内容和 revision 对不上。
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new ProfileError("profile.md 不是普通文件");
      const bytes = await handle.readFile();
      if (bytes.length > READ_MAX_BYTES) throw new ProfileError("profile.md 过大，无法安全读取");
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, ""); }
      catch { throw new ProfileError("profile.md 必须使用 UTF-8 编码"); }
      return { ns, text, revision: revisionOf(stat.mtimeMs, bytes), file, updatedAt: stat.mtimeMs,
        ...(bytes.length > PROFILE_MAX_BYTES ? { oversize: true } : {}) };
    } finally { await handle.close(); }
  }

  /** 整体替换画像（CAS）：同一命名空间串行；revision 不符、超限、含秘密都拒绝。返回新 revision。 */
  write(ns: string, content: string, expectedRevision: string): Promise<{ revision: string }> {
    let file: string;
    try { file = this.file(ns); } catch (error) { return Promise.reject(error); }
    const run = (this.chains.get(file) ?? Promise.resolve()).then(async () => {
      const text = content.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
      if (Buffer.byteLength(text, "utf8") > PROFILE_MAX_BYTES) throw new ProfileError(`画像超过 ${PROFILE_MAX_BYTES / 1024} KiB 上限`);
      if (containsSecret(text)) throw new ProfileError("画像包含凭据样式的内容，禁止保存", "secret");
      const before = await this.read(ns);
      if (before.revision !== expectedRevision) throw new ProfileError("画像已在别处被修改，请先读取最新内容再保存", "stale");
      await this.ensureDir(path.dirname(file));
      const tmp = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(tmp, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await fs.rename(tmp, file);
      } finally { await fs.rm(tmp, { force: true }).catch(() => undefined); }
      return { revision: (await this.read(ns)).revision };
    });
    this.chains.set(file, run.catch(() => undefined));
    return run;
  }

  /** 画像根目录与命名空间目录都不能是链接，避免写到数据卷之外。 */
  private async ensureDir(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    for (const d of [this.root, dir]) {
      const st = await fs.lstat(d);
      if (!st.isDirectory() || st.isSymbolicLink()) throw new ProfileError("画像目录不可为链接");
    }
  }
}

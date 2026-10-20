import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { isScope, parseAccess, type Access } from "../../context/access.js";
import type { ContextStore } from "../../context/store.js";

const REQUIREMENTS = "/etc/codex/requirements.toml";
export const BWRAP = "/usr/bin/bwrap";
const posix = (file: string) => process.platform === "win32" ? file.replace(/\\/g, "/") : file;
export const within = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
};

/** 仅接受入口脚本管理的 TOML 子集；不认识的文件系统配置一律关闭权限，不能部分解析后放行。 */
export function parseDenyRead(toml: string): string[] {
  // 字符串中的 # 保留；注释内的伪表头/键不能改变解析结果。
  const clean = toml.replace(/"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*'|#[^\r\n]*/g, token => token.startsWith("#") ? "" : token);
  const sections = [...clean.matchAll(/^\s*\[permissions\.filesystem\]\s*$/gm)];
  if (sections.length !== 1) throw new Error("deny_read 缺少唯一的 permissions.filesystem 表");
  const tail = clean.slice(sections[0]!.index! + sections[0]![0].length);
  const body = tail.split(/^\s*\[[\w.]+\]\s*$/m)[0]!.trim();
  const array = /^deny_read\s*=\s*\[([\s\S]*)\]\s*$/.exec(body);
  if (!array) throw new Error("deny_read 必须是受管的字符串数组");
  let rest = array[1]!.trim();
  const result: string[] = [];
  while (rest) {
    const token = /^("(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')/.exec(rest)?.[0];
    if (!token) throw new Error("deny_read 含不支持的 TOML 值");
    const value: unknown = token.startsWith('"') ? JSON.parse(token) : token.slice(1, -1);
    if (typeof value !== "string" || !value || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value)) {
      throw new Error("deny_read 路径必须是非空绝对路径");
    }
    // 入口脚本只用 *；支持 ?、**，其余 glob 语法保守拒绝，避免与 Codex 展开规则不一致。
    if (/[\[\]{}!()]/.test(value)) throw new Error("deny_read 含不支持的 glob 语法");
    result.push(path.normalize(value));
    rest = rest.slice(token.length).trim();
    if (!rest) break;
    if (!rest.startsWith(",")) throw new Error("deny_read 数组缺少逗号");
    rest = rest.slice(1).trim();
  }
  if (!result.length) throw new Error("deny_read 不得为空");
  return [...new Set(result)];
}

/** 新文件解析到最近存在的父目录；悬空链接也解析目标，不能借 mkdir/writeFile 绕过检查。 */
export async function policyRealpath(file: string, depth = 0): Promise<string> {
  if (depth > 40) throw new Error("路径符号链接过深");
  const absolute = path.resolve(file);
  try { return await fs.realpath(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const link = await fs.lstat(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (link?.isSymbolicLink()) return policyRealpath(path.resolve(path.dirname(absolute), await fs.readlink(absolute)), depth + 1);
  const parent = path.dirname(absolute);
  if (parent === absolute) throw new Error("路径没有可解析的父目录");
  return path.join(await policyRealpath(parent, depth + 1), path.basename(absolute));
}

export interface DeniedPath { path: string; directory: boolean }
export interface DenyRead { patterns: string[]; paths: DeniedPath[] }

/** 与普通路径通配一致：* 也匹配点开头名称；不能使用默认排除隐藏文件的 Node glob。 */
function globMatch(file: string, pattern: string): boolean {
  const parts = posix(pattern).split("/");
  const expression = parts.map((part, i) => part === "**"
    ? (i === parts.length - 1 ? ".*" : "(?:[^/]+/)*")
    : part.replace(/[.+^$|\\()[\]{}]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") + (i < parts.length - 1 ? "/" : "")).join("");
  return new RegExp("^" + expression + "$", process.platform === "win32" ? "isu" : "su").test(posix(file));
}

async function globPaths(pattern: string): Promise<string[]> {
  const root = path.parse(pattern).root;
  const parts = pattern.slice(root.length).split(path.sep);
  const pending = [{ file: root, index: 0 }];
  const visited = new Set<string>();
  const matches: string[] = [];
  while (pending.length) {
    const { file, index } = pending.pop()!;
    if (index === parts.length) { matches.push(file); continue; }
    const part = parts[index]!;
    if (!/[*?]/.test(part)) { pending.push({ file: path.join(file, part), index: index + 1 }); continue; }
    try {
      const key = `${await fs.realpath(file)}\0${index}`;
      if (visited.has(key)) continue;
      visited.add(key);
      if (part === "**") pending.push({ file, index: index + 1 });
      for (const entry of await fs.readdir(file, { withFileTypes: true })) {
        if (part !== "**" && !globMatch(entry.name, part)) continue;
        const child = path.join(file, entry.name);
        let directory = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          try { directory = (await fs.stat(child)).isDirectory(); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        if (part === "**") {
          if (directory) pending.push({ file: child, index });
          else if (index === parts.length - 1) matches.push(child);
        } else if (directory || index === parts.length - 1) pending.push({ file: child, index: index + 1 });
      }
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  return matches;
}

/** 每次调用重读、重新展开；配置丢失及展开失败均不能复用旧权限。 */
export async function loadDenyRead(requirementsFile = process.env.CODEX_REQUIREMENTS_FILE || REQUIREMENTS): Promise<DenyRead> {
  const patterns = parseDenyRead(new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(requirementsFile)));
  // DATA_DIR 等前缀可能是符号链接；保留原模式，并补上规范路径的模式，覆盖之后新建的目标。
  for (const pattern of [...patterns]) {
    const wildcard = pattern.search(/[*?]/);
    if (wildcard === -1) patterns.push(await policyRealpath(pattern));
    else {
      const prefix = path.dirname(pattern.slice(0, wildcard) + "_");
      patterns.push(path.join(await policyRealpath(prefix), path.relative(prefix, pattern)));
    }
  }
  const unique = [...new Set(patterns)];
  return { patterns: unique, paths: await expandDenyRead(unique) };
}

export async function expandDenyRead(patterns: readonly string[]): Promise<DeniedPath[]> {
  const found = new Map<string, DeniedPath>();
  for (const pattern of patterns) {
    const candidates = /[*?]/.test(pattern) ? await globPaths(pattern) : [pattern];
    for (const file of candidates) {
      try {
        const canonical = await fs.realpath(file);
        const stat = await fs.stat(canonical);
        found.set(canonical, { path: canonical, directory: stat.isDirectory() });
      } catch (error) {
        // 尚未创建的受管文件仍由 patterns 拒绝；只忽略不存在，不能忽略 EACCES 等展开错误。
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return [...found.values()].sort((a, b) => a.path.length - b.path.length)
    .filter((item, index, all) => !all.slice(0, index).some(parent => parent.directory && within(parent.path, item.path)));
}

function matchesDeny(file: string, deny: DenyRead): boolean {
  if (deny.paths.some(item => within(item.path, file))) return true;
  // 匹配每级父路径，使 *.sqlite* 命中目录时其子文件也被拒绝；新建文件也不会漏掉。
  for (let current = file; ; current = path.dirname(current)) {
    if (deny.patterns.some(pattern => globMatch(current, pattern))) return true;
    if (path.dirname(current) === current) return false;
  }
}

interface PiDenyRead extends DenyRead { workspaceRoots: string[] }

export interface PiSandboxOptions {
  dataDir: string;
  /** 空值使用 dataDir/skills；off 禁用技能写入。 */
  skillsDir?: string;
  /** Codex 的 WORKSPACE_DIR；必须由调用方传入，缺失时关闭工具权限。 */
  workspaceDir?: string;
  key: string;
  request: { ticket: string; access: string; senderIsOwner?: boolean; actorIsOwner?: boolean };
  store: Pick<ContextStore, "mediaPathAllowed">;
  requirementsFile?: string;
}

export class PiPathPolicy {
  readonly access: Access;
  readonly ticket: string;
  readonly workspace: string;
  readonly workRoot: string;
  readonly skillsDir?: string;
  private readonly images: string;
  private readonly incoming: string;
  private readonly media: string;
  constructor(readonly options: PiSandboxOptions) {
    const { key, request, dataDir } = options;
    const access = parseAccess(request.access);
    if ((key !== "owner" && !isScope(key)) || !access ||
        (key === "owner" ? access.kind !== "all" : access.kind === "all" ? request.actorIsOwner !== true : access.scope !== key)) {
      throw new Error("pi 工作目录缺少匹配的会话键与访问范围");
    }
    if (!/^[A-Za-z0-9_-]+$/.test(request.ticket)) throw new Error("pi 缺少有效票据");
    this.access = Object.freeze({ ...access });
    this.ticket = request.ticket;
    this.workRoot = path.resolve(dataDir, "pi-work");
    this.workspace = path.join(this.workRoot, key.replace(/:/g, "_"));
    this.images = path.resolve(dataDir, "images", this.ticket);
    this.incoming = path.resolve(dataDir, "incoming", this.ticket);
    this.media = path.resolve(dataDir, "media");
    this.skillsDir = options.skillsDir === "off" ? undefined : path.resolve(options.skillsDir || path.join(dataDir, "skills"));
  }

  async deny(): Promise<PiDenyRead> {
    const { dataDir, workspaceDir } = this.options;
    if (!workspaceDir?.trim()) throw new Error("pi 沙箱缺少 WORKSPACE_DIR");
    const workspace = path.resolve(workspaceDir);
    // 保留配置路径与规范路径；尚不存在的目录也禁读，链接不能绕过遮蔽或配置校验。
    const workspaceRoots = [...new Set([workspace, await policyRealpath(workspace)])];
    const dataRoots = [path.resolve(dataDir), await policyRealpath(dataDir)];
    if (workspaceRoots.some(root => root === path.parse(root).root || dataRoots.some(dir => within(root, dir)))) {
      throw new Error("pi 沙箱 WORKSPACE_DIR 不能是根目录或包含 DATA_DIR");
    }
    const deny = await loadDenyRead(this.options.requirementsFile);
    const extra = [path.resolve(dataDir, "pi.sqlite*"), path.resolve(dataDir, "pi-threads*"), ...workspaceRoots];
    return { workspaceRoots, patterns: [...deny.patterns, ...extra], paths: [...deny.paths, ...await expandDenyRead(extra)] };
  }

  async check(file: string, mode: "read" | "write", deny?: PiDenyRead): Promise<string> {
    deny ??= await this.deny();
    const absolute = path.resolve(this.workspace, file);
    const canonical = await policyRealpath(absolute);
    const forbidden = () => { throw new Error(`pi 沙箱拒绝${mode === "read" ? "读取" : "写入"}：${file}`); };
    // Codex 工作区整棵禁读写，优先于本票据图片、incoming 与媒体授权例外。
    if ([absolute, canonical].some(p => deny.workspaceRoots.some(root => within(root, p)))) forbidden();
    // 在主进程内的文件接口不得读取宿主 proc、设备或内核接口。
    if ([absolute, canonical].some(p => ["/proc", "/sys", "/dev"].some(root => within(path.resolve(root), p)))) forbidden();
    // 同时校验词法路径与 realpath：票据目录/工作区自身被换成链接也不能扩大授权根。
    const inRoot = (root: string) => within(root, absolute) && within(root, canonical);
    const otherWork = (p: string) => within(this.workRoot, p) && !within(this.workspace, p);
    if (otherWork(absolute) || otherWork(canonical)) forbidden();
    const state = [path.resolve(this.options.dataDir, "pi.sqlite*"), path.resolve(this.options.dataDir, "pi-threads*")];
    if ([absolute, canonical].some(p => state.some(pattern => globMatch(p, pattern)))) forbidden();
    if (mode === "write") {
      const skillsWrite = this.options.request.senderIsOwner === true && this.skillsDir !== undefined && inRoot(this.skillsDir);
      if (!inRoot(this.workspace) && !inRoot(this.images) && !skillsWrite) forbidden();
      // 本票据图片是 deny_read(images) 的明确例外；其他受管禁读目标仍不可覆写。
      if (!inRoot(this.images) && (matchesDeny(absolute, deny) || matchesDeny(canonical, deny))) forbidden();
    } else if (!inRoot(this.images) && !inRoot(this.incoming)) {
      if (inRoot(this.media)) {
        if (!(await fs.stat(canonical)).isFile() || !this.options.store.mediaPathAllowed(this.access, canonical)) forbidden();
      } else if (matchesDeny(absolute, deny) || matchesDeny(canonical, deny)) forbidden();
    }
    return canonical;
  }
}

/** 顺序很重要：先隐藏整棵 pi-work，再只挂回本会话，避免新建会话目录的枚举竞态。 */
export function bwrapArgs(workspace: string, workRoot: string, denied: readonly DeniedPath[], command: string | readonly string[],
  options?: { senderIsOwner?: boolean; skillsDir?: string }): string[] {
  const args = ["--unshare-user", "--unshare-pid", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
    "--ro-bind", "/", "/", "--proc", "/proc", "--remount-ro", "/proc",
    "--dev", "/dev", "--tmpfs", "/dev/shm", "--remount-ro", "/dev/shm", "--remount-ro", "/dev",
    "--tmpfs", "/sys", "--remount-ro", "/sys", "--tmpfs", "/tmp",
    "--tmpfs", workRoot, "--bind", workspace, workspace, "--remount-ro", workRoot];
  // 只读根之后开放 owner 技能目录；deny 最后覆盖，避免可写挂载重新暴露受保护文件。
  if (options?.senderIsOwner === true && options.skillsDir && options.skillsDir !== "off") args.push("--bind", options.skillsDir, options.skillsDir);
  for (const item of denied) {
    // proc、sys、dev 已被新挂载遮蔽；保留工作区内显式 deny 的优先级。
    if (["/proc", "/sys", "/dev"].some(root => within(root, item.path))) continue;
    if (item.directory) args.push("--tmpfs", item.path, "--remount-ro", item.path);
    else args.push("--ro-bind", "/dev/null", item.path);
  }
  args.push("--chdir", workspace, "--", ...(typeof command === "string" ? ["/bin/bash", "--noprofile", "--norc", "-c", command] : command));
  return args;
}

export async function requireBwrap(): Promise<void> {
  if (process.platform !== "linux") throw new Error("pi bash 沙箱仅支持 Linux bwrap");
  await fs.access(BWRAP, constants.X_OK);
}

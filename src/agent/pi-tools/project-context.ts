import { promises as fs } from "node:fs";
import path from "node:path";
import { log } from "../../shared/log.js";

const CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
const MAX_BYTES = 128 * 1024;

export interface ProjectContextFile { path: string; content: string }
export interface ProjectContextOptions { dataDir: string; workspaceDir: string; cwd?: string }

/** 单次加载；持续渲染应复用 ProjectContextLoader，以保留缓存与告警去重。 */
export function loadProjectContextFiles(options: ProjectContextOptions): Promise<ProjectContextFile[]> {
  return new ProjectContextLoader(options).load(options.cwd);
}

export function renderProjectContext(files: readonly ProjectContextFile[]): string | undefined {
  if (!files.length) return undefined;
  const attribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return "Project-specific instructions and guidelines:\n\n" + files.map(file =>
    `<project_instructions path="${attribute(file.path)}">\n${file.content}\n</project_instructions>`).join("\n\n");
}

/** 只检查运维目录和 pi-work 的直接子目录，不向上遍历。 */
export class ProjectContextLoader {
  private readonly workspaceDir: string;
  private readonly workRoot: string;
  private readonly files = new Map<string, { stamp: string; file?: ProjectContextFile }>();
  private readonly warnings = new Map<string, string>();
  private readonly invalidCwds = new Set<string>();
  private readonly rendered = new Map<string, { files: ProjectContextFile[]; text: string | undefined }>();

  constructor(options: Omit<ProjectContextOptions, "cwd">) {
    this.workspaceDir = path.resolve(options.workspaceDir);
    this.workRoot = path.resolve(options.dataDir, "pi-work");
  }

  private warn(file: string, stamp: string, reason: string): void {
    const key = `${stamp}:${reason}`;
    if (this.warnings.get(file) === key) return;
    this.warnings.set(file, key);
    log.warn("pi project context skipped", { path: file, reason });
  }

  private async readDirectory(dir: string): Promise<ProjectContextFile | undefined> {
    for (const name of CANDIDATES) {
      const file = path.join(dir, name);
      let stamp = "unavailable";
      try {
        const stat = await fs.lstat(file);
        stamp = `${stat.mtimeMs}:${stat.size}`;
        if (stat.isSymbolicLink() || !stat.isFile()) {
          this.files.delete(file);
          this.warn(file, stamp, "not a regular file");
          continue;
        }
        if (stat.size > MAX_BYTES) {
          this.files.delete(file);
          this.warn(file, stamp, "exceeds 128 KiB");
          return undefined;
        }
        const cached = this.files.get(file);
        if (cached?.stamp === stamp) return cached.file;
        const bytes = await fs.readFile(file);
        if (bytes.length > MAX_BYTES) {
          this.warn(file, stamp, "exceeds 128 KiB");
          return undefined;
        }
        const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
        const result = content.trim() ? { path: file, content } : undefined;
        this.files.set(file, { stamp, file: result });
        this.warnings.delete(file);
        return result;
      } catch (error) {
        this.files.delete(file);
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          this.warnings.delete(file);
          continue;
        }
        this.warn(file, stamp, code ?? "unreadable UTF-8 file");
        return undefined;
      }
    }
    return undefined;
  }

  async load(cwd?: string): Promise<ProjectContextFile[]> {
    const dirs = [this.workspaceDir];
    if (cwd !== undefined) {
      const dir = path.resolve(cwd);
      if (!path.isAbsolute(cwd) || path.relative(this.workRoot, path.dirname(dir)) !== "") {
        if (!this.invalidCwds.has(cwd)) {
          this.invalidCwds.add(cwd);
          log.warn("pi project context cwd ignored", { cwd });
        }
      } else if (path.relative(this.workspaceDir, dir) !== "") dirs.push(dir);
    }
    const result: ProjectContextFile[] = [];
    for (const dir of dirs) {
      const file = await this.readDirectory(dir);
      if (file) result.push(file);
    }
    return result;
  }

  async render(cwd?: string): Promise<string | undefined> {
    const files = await this.load(cwd);
    const key = cwd ?? "";
    const cached = this.rendered.get(key);
    if (cached && cached.files.length === files.length && files.every((file, i) => file === cached.files[i])) return cached.text;
    const text = renderProjectContext(files);
    // 戳变但正文未变时仍保留已有字符串；不同会话分别缓存，避免互相覆盖。
    if (cached && cached.text === text) { cached.files = files; return cached.text; }
    this.rendered.set(key, { files, text });
    return text;
  }
}

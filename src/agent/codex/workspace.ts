import { promises as fs } from "node:fs";
import path from "node:path";
import { isScope } from "../../context/access.js";

/** 0.163 的命名权限配置与 sandbox_mode 互斥，必须整份按轮注入。 */
export function codexWorkspacePolicy(base: string, dataDir: string, key: string, sandbox: string, network = true, codexHome = path.join(dataDir, "codex")) {
  if (key !== "owner" && !isScope(key)) throw new Error("非法的 codex 线程键");
  if (sandbox !== "workspace-write" && sandbox !== "read-only") throw new Error("会话隔离不允许 danger-full-access");
  const root = path.resolve(base), data = path.resolve(dataDir);
  const relativeData = path.relative(root, data);
  // 父目录隐藏必须覆盖全部会话目录，且不能同时隐藏运行数据或成为系统根目录。
  if (root === path.parse(root).root || data === root || (!relativeData.startsWith("..") && !path.isAbsolute(relativeData))) {
    throw new Error("WORKSPACE_DIR 不得包含 DATA_DIR 或指向系统根目录");
  }
  const workspaceDir = path.join(root, key.replace(":", "_"));
  const writableRoots = sandbox === "read-only" ? [] : [workspaceDir,
    ...(key === "owner" ? [path.join(data, "prompts"), path.join(data, "workflows")] : [])];
  const filesystem: Record<string, string> = {
    ":root": "read", [root]: "deny", [path.join(data, "pi-work")]: "deny",
    // 官方请求 trace 含各会话的完整输入，不能成为绕过线程隔离的读取入口。
    [path.join(path.resolve(codexHome), "trace")]: "deny",
    [workspaceDir]: sandbox === "read-only" ? "read" : "write",
  };
  for (const dir of writableRoots) filesystem[dir] = "write";
  const entries = Object.entries(filesystem).map(([dir, access]) => `${JSON.stringify(dir)}=${JSON.stringify(access)}`).join(",");
  const args = ["-c", `permissions.cs_agent_scope={filesystem={${entries}},network={enabled=${network}}}`,
    "-c", 'default_permissions="cs_agent_scope"',
    // 同时清空 entrypoint 的旧全局写入列表；命名权限配置是实际安全边界。
    "-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(writableRoots)}`,
    "-c", 'approval_policy="never"'];
  return { workspaceDir, writableRoots, args };
}

/** 由父进程创建目录，拒绝 scope 目录链接；会话只能写自己的目录，无法替换父目录的子项。 */
export async function prepareCodexWorkspace(base: string, workspaceDir: string): Promise<string> {
  await fs.mkdir(base, { recursive: true });
  const parent = await fs.lstat(base);
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("WORKSPACE_DIR 不可为链接");
  const realBase = await fs.realpath(base);
  const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (!samePath(realBase, path.resolve(base))) throw new Error("WORKSPACE_DIR 的上级目录不可为链接");
  await fs.mkdir(workspaceDir, { recursive: true });
  const st = await fs.lstat(workspaceDir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("codex 会话工作区不可为链接");
  if (!samePath(path.dirname(await fs.realpath(workspaceDir)), realBase)) throw new Error("codex 会话工作区越界");
  // 非 Git 目录只自动加载 cwd 的 AGENTS.md；父目录的运维指引需要显式带入每轮。
  for (const name of ["AGENTS.override.md", "AGENTS.md"]) {
    const file = path.join(base, name);
    const entry = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!entry) continue;
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 128 * 1024) throw new Error("工作区 AGENTS.md 必须是普通文本文件且不超过 128 KiB");
    const text = await fs.readFile(file, "utf8");
    if (text.trim()) return text;
  }
  return "";
}

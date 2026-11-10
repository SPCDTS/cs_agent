import { promises as fs } from "node:fs";
import path from "node:path";

async function checkTree(root: string): Promise<void> {
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink() || !(stat.isFile() || stat.isDirectory())) throw new Error("resource_links_not_supported");
  if (stat.isDirectory()) for (const name of await fs.readdir(root)) await checkTree(path.join(root, name));
}
async function copyTree(source: string, target: string): Promise<void> {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink() || !(stat.isFile() || stat.isDirectory())) throw new Error("resource_links_not_supported");
  if (stat.isDirectory()) {
    await fs.mkdir(target);
    for (const name of await fs.readdir(source)) await copyTree(path.join(source, name), path.join(target, name));
  } else await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
  await fs.chmod(target, stat.mode);
  await fs.utimes(target, stat.atime, stat.mtime);
}

/** 仅在 guest 内、首次用户命令前执行；重试许可由宿主私有的准备记录保证。 */
export async function prepareResourceFiles(workPath: string, sourcePath?: string): Promise<void> {
  const work = path.resolve(workPath), source = sourcePath ? path.resolve(sourcePath) : undefined;
  if (work === path.parse(work).root) throw new Error("resource_invalid_directory");
  if (source) {
    const relative = path.relative(work, source), reverse = path.relative(source, work);
    const inside = (p: string) => !p || p !== ".." && !p.startsWith(".." + path.sep) && !path.isAbsolute(p);
    if (inside(relative) || inside(reverse)) throw new Error("resource_directories_overlap");
    if (!(await fs.lstat(source)).isDirectory()) throw new Error("resource_source_required");
    await checkTree(source);
  }
  await fs.mkdir(work, { recursive: true });
  await checkTree(work);
  // 删除范围限于已解析的目标目录；来源与目标均不接受链接。
  for (const name of await fs.readdir(work)) {
    const child = path.resolve(work, name);
    if (path.dirname(child) !== work) throw new Error("resource_invalid_directory");
    await fs.rm(child, { recursive: true });
  }
  if (source) for (const name of await fs.readdir(source)) await copyTree(path.join(source, name), path.join(work, name));
}

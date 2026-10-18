import { promises as fs } from 'node:fs';
import path from 'node:path';

/** 每个目录分量都拒绝链接；路径仅来自受管根目录内的索引或 trace 引用。 */
export async function localFile(root: string, file: string): Promise<string> {
  const base = path.resolve(root), target = path.resolve(file), rel = path.relative(base, target);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('invalid path');
  let current = base;
  for (const part of ['', ...rel.split(path.sep)]) {
    if (part) current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('linked file');
  }
  const real = await fs.realpath(target), realRoot = await fs.realpath(base), relative = path.relative(realRoot, real);
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('outside root');
  return real;
}
export async function smallJson(root: string, file: string, maxBytes = 8 * 1024 * 1024): Promise<unknown> {
  const handle = await fs.open(await localFile(root, file), 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('oversized payload');
    const bytes = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size) throw new Error('changed payload');
    return JSON.parse(bytes.toString('utf8'));
  } finally { await handle.close(); }
}

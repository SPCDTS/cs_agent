import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 每次 Vitest 运行统一构建一次，避免 stdio 子进程使用遗漏依赖的旧 dist。 */
export default function setup(): void {
  const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd run build' : 'npm run build', {
    cwd, encoding: 'utf8', shell: true, timeout: 120_000,
  });
  if (result.status !== 0) throw new Error(`stdio build failed: ${result.stdout}${result.stderr}`);
}

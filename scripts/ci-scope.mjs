import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const documents = new Set(['README.md', 'AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'SECURITY.md']);

export function checkScope(paths) {
  // 无法确定比较基线、首次推送或手动运行时，执行全部检查。
  if (paths === null) return { code: true, native: true };
  return {
    code: paths.some(path => !path.startsWith('docs/') && !documents.has(path)),
    native: paths.some(path => path.startsWith('runner/') || path.startsWith('scripts/ci-scope') || path === '.github/workflows/ci.yml'),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { BASE_SHA, HEAD_SHA, GITHUB_EVENT_NAME, GITHUB_OUTPUT } = process.env;
  const full = GITHUB_EVENT_NAME === 'workflow_dispatch' || !BASE_SHA || /^0+$/.test(BASE_SHA);
  const paths = full ? null : execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', BASE_SHA, HEAD_SHA], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const scope = checkScope(paths);
  appendFileSync(GITHUB_OUTPUT, `code=${scope.code}\nchanged=${scope.native}\n`, 'utf8');
  console.log(JSON.stringify({ changedFiles: paths?.length ?? null, ...scope }));
}

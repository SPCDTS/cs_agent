import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkScope } from './ci-scope.mjs';

test('仅说明文档不触发代码检查或部署，混合代码变更仍需检查', () => {
  assert.deepEqual(checkScope(['docs/DEPLOY.md', 'README.md', 'AGENTS.md']), { code: false, native: false });
  assert.deepEqual(checkScope(['README.md', 'workers/src/github/app.ts']), { code: true, native: false });
  assert.deepEqual(checkScope(['workers/skills/example/SKILL.md']), { code: true, native: false });
});

test('runner、CI 配置和未知基线保留 Windows 原生检查', () => {
  for (const paths of [['runner/src/guest.ts'], ['.github/workflows/ci.yml'], ['scripts/ci-scope.mjs'], null]) {
    assert.deepEqual(checkScope(paths), { code: true, native: true });
  }
});

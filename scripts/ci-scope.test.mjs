import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkScope } from './ci-scope.mjs';

test('仅说明文档不触发代码检查或部署，混合代码变更仍需检查', () => {
  assert.deepEqual(checkScope(['docs/DEPLOY.md', 'README.md', 'AGENTS.md']), { code: false });
  assert.deepEqual(checkScope(['README.md', 'workers/src/github/app.ts']), { code: true });
  assert.deepEqual(checkScope(['workers/skills/example/SKILL.md']), { code: true });
});

test('未知基线执行完整检查', () => {
  assert.deepEqual(checkScope(null), { code: true });
});

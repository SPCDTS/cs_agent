// 不依赖 cloudflare:test / workerd 运行时的纯逻辑单测划入轻量 node 项目，加快反馈。
export const NODE_TESTS = [
  "test/chat-navigation-layout.test.ts",
  "test/events-model.test.ts",
  "test/execution-env.test.ts",
  "test/github-app.test.ts",
  "test/github-connect-diagnostics.test.ts",
  "test/github-upstream-diagnostics.test.ts",
  "test/github-user-auth.test.ts",
  "test/mcp-config-schema.test.ts",
  "test/mcp-transport.test.ts",
  "test/memory-permissions.test.ts",
  "test/policy.test.ts",
  "test/skill-runtime-manifest.test.ts",
  "test/topology-layout.test.ts",
  "test/web-page.test.ts",
  "test/web-search.test.ts",
];

// 直接测试 ThreadDO 等模块而未显式 import cloudflare:test，但会间接触发 cloudflare:workers 运行时解析的测试（当前已全部归并至显式导入 cloudflare:test 的域测试文件）。
export const WORKERS_RUNTIME_ONLY = [];

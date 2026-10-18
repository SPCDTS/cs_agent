# 第三方来源与许可证

## CC Switch

- 项目：[CC Switch](https://github.com/farion1231/cc-switch)。
- 许可证：[MIT License](https://github.com/farion1231/cc-switch/blob/main/LICENSE)，版权声明：Copyright (c) 2025 Jason Young。
- 使用位置：`src/obs/sessions/types.ts` 的统一会话、回合、内容块与按需加载引用模型。
- 使用方式：借鉴上游 `src/types.ts` 的类型组织和会话阅读设计，并按本项目已确认的 `docs/DESIGN-observability-v2.md` §2 实现；未引入其 React、Tauri 或 Rust 实现，也未增加运行时依赖。
- 版本记录：类型模型设计参考上游主分支，许可证于 2026-10-18 核验；本项目未安装 CC Switch 软件包。

后续分组若引入新的第三方实现、词表或前端资源，须在实际引入时补充固定版本、来源和许可证。

## js-tiktoken 与 o200k_base

- 固定运行时版本：`js-tiktoken@1.0.21`，来源：[dqbd/tiktoken](https://github.com/dqbd/tiktoken)，许可证：[MIT](https://github.com/dqbd/tiktoken/blob/main/LICENSE)，Copyright (c) 2022 OpenAI, Shantanu Jain。
- 使用位置：`src/obs/context/tokens.ts`，通过公开入口 `js-tiktoken/lite` 与 `js-tiktoken/ranks/o200k_base` 本地加载词表并缓存 encoder。词表随 npm 包分发，不从 CDN 下载。
- `Dockerfile` 的 build 阶段先 `npm ci`，再 `npm prune --omit=dev`；runtime 阶段复制完整生产 `node_modules`。该包在 `dependencies` 中，词表不会被裁剪；本组没有修改 Dockerfile，也没有部署镜像。

## Codex 上下文重建与官方 trace 格式

- 参考版本：OpenAI Codex `rust-v0.163.0`，来源：[rollout_reconstruction.rs](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/session/rollout_reconstruction.rs)、[history.rs](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/context_manager/history.rs)、[normalize.rs](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/context_manager/normalize.rs) 与 [rollout-trace](https://github.com/openai/codex/tree/rust-v0.163.0/codex-rs/rollout-trace)。许可证：[Apache-2.0](https://github.com/openai/codex/blob/rust-v0.163.0/LICENSE)。
- 使用方式：按上游行为独立实现 TypeScript 观测投影与 bundle v1 只读解析，没有引入 Rust 代码或二进制依赖。来源与边界说明见 [O3 上下文分析接口](O3-context-api.md)。

## vis-timeline

- 固定运行时版本：`vis-timeline@8.5.4`（2026-08-12 发布），来源：[visjs/vis-timeline](https://github.com/visjs/vis-timeline)，许可证：双许可 [Apache-2.0](https://github.com/visjs/vis-timeline/blob/master/LICENSE.Apache-2.0.txt) 或 [MIT](https://github.com/visjs/vis-timeline/blob/master/LICENSE.MIT.txt)，Copyright (c) 2011-2017 Almende B.V.，(c) 2017-2019 visjs contributors。
- 包内许可证文件：`LICENSE.Apache-2.0.txt`、`LICENSE.MIT.txt`（随 npm 包分发，镜像内保留）。
- 使用位置：`/memory/scopes/:scope` 时间线（设计 §5.1）。`src/obs/ui/vendor.ts` 启动时从 `node_modules/vis-timeline` 读取 `standalone/umd/vis-timeline-graph2d.min.js` 与 `styles/vis-timeline-graph2d.min.css` 各一次（去掉 sourceMappingURL 注释；JS 内唯一的 `styleInject` 入口改为不执行——它会追加不带 nonce 的 `<style>` 而被 CSP 拒绝，相同样式已由 CSS 文件提供），经已鉴权的 `/assets/vendor/vis-timeline.js` / `.css` 提供；白名单只有这两项，其它路径 404，不走 CDN。
- standalone 构建已内含 vis-data、moment 等依赖，浏览器端不再加载其它文件。npm 按 peerDependencies 自动安装的 `vis-data`、`vis-util`、`moment`、`xss` 等只出现在锁文件中，运行时不使用；`dependencies` 只新增 vis-timeline 一项。
- 渲染约定：条目内容、悬浮提示和分组标题全部以 DOM 元素（`textContent`）传入，不走库内的 HTML 字符串分支；库通过 CSSOM 设置位置，不需要 `unsafe-inline`。为加载同源样式表，CSP 的 `style-src` 由 `'nonce-…'` 扩为 `'self' 'nonce-…'`。

# 第三方来源与许可证

## CC Switch

- 项目：[CC Switch](https://github.com/farion1231/cc-switch)。
- 许可证：[MIT License](https://github.com/farion1231/cc-switch/blob/main/LICENSE)，版权声明：Copyright (c) 2025 Jason Young。
- 使用位置：`src/obs/sessions/types.ts` 的统一会话、回合、内容块与按需加载引用模型。
- 使用方式：借鉴上游 `src/types.ts` 的类型组织和会话阅读设计，并按本项目已确认的 `docs/DESIGN-observability-v2.md` §2 实现；未引入其 React、Tauri 或 Rust 实现，也未增加运行时依赖。
- 版本记录：类型模型设计参考上游主分支，许可证于 2026-10-18 核验；本项目未安装 CC Switch 软件包。

后续分组若引入新的第三方实现、词表或前端资源，须在实际引入时补充固定版本、来源和许可证。

# 观测测试样本

`codex-rollout-anonymized.jsonl` 按本地 `data/codex/sessions/2026/10/17` 的 Codex 0.163 rollout 小片段整理，保留 `session_meta`、`turn_context`、消息、工具调用与输出、`token_usage_record` / `token_count` 以及完成事件的实际字段结构。

线程、用户、账户、回合、调用、请求 ID 与正文均替换为测试占位，QQ 号码与凭据不保留；时间与 token 数固定为可断言的数据。加密 reasoning 只保留不可用占位。压缩、异常、追加、截短和大文件边界由测试临时生成，不读取或改写运行数据目录。

O3 新增 `context-compaction.jsonl` 与 `context-resume-abort.jsonl`：沿用真实 0.163.0 rollout 的字段结构，用手写问答、替换历史及中止事件构造确定性序列；后者作为同会话的第二个 resume 文件。只读检查的三个本地实际 rollout 中没有 compaction 样本，因此压缩、resume 分文件与中止组合是合成回归样本，不宣称来自一次真实压缩会话。正文、路径、时间及所有 ID 均为占位数据。

官方 trace 的测试在临时目录生成 `manifest.json`、`trace.jsonl` 与 `payloads/*.json`，字段来自固定版本上游 `raw_event.rs`、`payload.rs`、`inference.rs`，覆盖精确请求、增量请求链、缺失文件、未知布局和非法路径。没有录制真实模型请求，也没有运行 `trace-reduce` 写入运行目录。

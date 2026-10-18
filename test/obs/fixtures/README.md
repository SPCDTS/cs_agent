# 观测测试样本

`codex-rollout-anonymized.jsonl` 按本地 `data/codex/sessions/2026/10/17` 的 Codex 0.163 rollout 小片段整理，保留 `session_meta`、`turn_context`、消息、工具调用与输出、`token_usage_record` / `token_count` 以及完成事件的实际字段结构。

线程、用户、账户、回合、调用、请求 ID 与正文均替换为测试占位，QQ 号码与凭据不保留；时间与 token 数固定为可断言的数据。加密 reasoning 只保留不可用占位。压缩、异常、追加、截短和大文件边界由测试临时生成，不读取或改写运行数据目录。

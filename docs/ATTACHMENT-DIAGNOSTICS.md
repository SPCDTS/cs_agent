# QQ 附件诊断

附件工具会产生结构化 `media_stage` 日志。每次调用生成新的随机 `traceId`；失败结果返回同一诊断编号。
用该编号关联日志与 Thread 的 `media_recall` / `media_send` 审计，不能把统一提示当作上传失败或超限证明。

## 阶段与关联

- `authorize/repository/recall/lookup/metadata`：回合授权、资产仓库、调用、媒体元数据查找。
- `get_msg`：仅在本会话已持有消息且本地媒体记录为空时回退查 OneBot。
- `resolve_url` 与 `get_private_file_url/get_group_file_url/get_file/get_image/get_record`：选择后才解析引用；OneBot action 即阶段名。
- `download/store/asset_get`：公网下载、私有资产写入、已有资产读取。图片由 Bridge 导入时，`get_image` 覆盖该 RPC 全过程，不伪造本地下载/存储阶段。
- `audit`：最终审计写入。成功结果不会因审计失败变成附件失败；失败审计也不会覆盖原业务错误，且不自动重试。
- 发送复用安全边界并记录 `export/deliver`，不改变发送幂等或授权政策。

每个执行阶段输出 start / success 或 failure、毫秒耗时。集合阶段可能没有 ordinal；附件阶段带 1–100 的 ordinal。
scope 来自宿主核验的物理会话（不是模型提供的目标）；授权完成前为 unknown。
并行解析各附件共享 traceId，但 ordinal 独立。错误审计包含最先失败的阶段。
日志有界：工具最多选择5个附件；不逐块、逐字节或逐重定向输出。

## 错误与隐私

稳定错误码采用显式白名单。OneBot媒体读取区分 `onebot_failed/onebot_timeout/onebot_disconnected`，
API失败只保留有界整数retcode，不透传wording、原始响应或错误文本。
HTTP下载失败只记录100–599状态码；原生异常仅分类为超时、取消、JSON、类型或未知错误。
内部阶段重新抛出原异常对象，不把未知 Error.message 当作错误码。

日志及审计不含 token、cookie、URL（包括hostname/query）、文件名、文件内容、消息正文、原始请求响应、stack/cause。
消息ID只接受最多20位的有符号数字；合成上传ID可能含URL，统一记为redacted。scope只接受owner或数字QQ会话。
所有字符串来自固定枚举或有界校验，耗时限制在0–86400000毫秒。日志sink失败不影响业务。
已有下载地址、公网地址检查、大小限制、来源检查保持原样；本次没有增加刷新URL或重复导入策略。

## 排障与局限

优先按失败结果中的traceId筛选 `event=media_stage`，先找最内层failure，再查对应审计result。
同一编号出现store success、audit failure表示资产已成功取得，不要仅因审计失败重试导入。
`events`审计本身不可用时仅依赖结构化控制台日志；日志采样、保留期或平台采集故障仍可能造成缺失。
日志写入是best effort，不保证所有阶段一定可见，也不会将历史故障补记成当前证据。

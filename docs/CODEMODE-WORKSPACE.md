# Code Mode 输出文件

主会话和有编码权限的子 agent 都通过 `Harness.open({ env })` 获得 pi-durable 的 `ExecutionEnv`。主会话在 `workers/src/thread/runtime.ts` 装配文件环境、资源选择和媒体发送权限；子 agent 在 `workers/src/subagent/do.ts` 装配。文件环境复用 Cloudflare `/work` 工作区，与现有 read / write / edit / bash 使用同一份已提交数据。

## 截图保存和发送

1. 远程 MCP 返回图片，Code Mode 脚本调用 `image(block)`。
2. pi-durable 在脚本输出阶段调用 `api.env.createTempDir` 和 `writeFile`，将原始图片字节保存到 `/work/.codemode/<时间戳>-<UUID>-pi-codemode-/image-N.png` 等路径。超长文本也使用同一文件环境保存完整内容。
3. 写入经工作区事务、容器快照和 R2 提交完成，Code Mode 才返回 `Image saved to ...`。模型同时收到图片内容，不需要再次读取文件才能看图。
4. 主 agent 可直接调用 `send_file({path})` 发送已保存图片。子 agent 没有发送工具，应汇报 `sandboxId` 和路径；父 agent 用 `send_file({sandboxId,path})` 导出对应资源的文件。

这些路径属于 Cloudflare 工作区，不是远程 Windows VM 的路径。主会话默认使用当前会话资源；子 agent 使用创建时分配的资源 ID，同一个 ID 共享文件。指定资源发送仍限于主人拥有的 Cloudflare 资源，群会话不能借此访问其他工作区。

## 生命周期与失败行为

输出目录随工作区持久化，Harness 关闭和容器重建不会直接删除它们。下次创建输出目录时，最多清理十个已超过七天的受管目录；长期没有新输出时，不承诺按时清除。只识别本模块格式的目录，不清理普通目录或链接。并发清理造成的 `not_found` 视为目录已删除，其他清理错误继续报告。需长期保留的文件应复制到 `/work/out/` 等其他位置。历史 R2 快照和 blob 的释放仍由既有工作区 GC 处理。

每次文件访问重新检查当前任务权限；子 agent 经父会话 RPC 验证身份、会话代次、任务状态和资源分配。二进制 RPC 保留 `Uint8Array`，不经 JSON 转换。文件仍受单个 10 MiB、整个工作区 50 MiB 的配额约束。保存失败或权限已撤销时，Code Mode 输出失败原因而非成功路径；原有图片内容仍可交给模型。

当前适配提供路径解析、文本/二进制读取、写入和临时文件/目录，满足 Code Mode 图片和全文输出。高级文件句柄、监听等接口明确返回 `not_supported`，环境 shell 返回 `shell_unavailable`；命令执行继续通过现有 bash 工具。Code Mode 脚本本身没有因此获得 Node、fetch 或直接文件系统访问能力。

pi-durable 当前的 `FileErrorCode` 没有文件过大的专用分类；超限时分类为 `unknown`，原始消息 `too_large` 保留并由 Code Mode 展示，不会替换成笼统的失败消息。

回归测试覆盖原生 Files 的二进制边界、R2 提交后重建、真实 Harness/QuickJS 的图片自动保存与发送、保存失败、权限撤销和子 agent 资源路由；容器进程及外部消息传输使用测试替身，不依赖线上凭据。

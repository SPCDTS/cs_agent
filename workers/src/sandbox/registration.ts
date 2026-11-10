import { EXEC_MAX_TIMEOUT_MS, WORK_ROOT } from "./client";

export const CLOUDFLARE_INSTRUCTIONS =
`沙箱工具 read / write / edit / bash 只通过 Code Mode 的 await tools.<名称>(参数) 调用，默认作用在本会话的 Cloudflare Linux 沙箱；需要指定其他已授权 Cloudflare 资源时传 sandboxId。环境为（Debian，带 python3、node、git、curl），工作目录 ${WORK_ROOT}，路径只能在 ${WORK_ROOT} 下。` +
    `沙箱空闲 3 分钟后停止，已成功提交的 ${WORK_ROOT} 源码会从私有存储恢复；新产生的 .git、node_modules、.wrangler 只留在当前容器，停止或重建后可能丢失。源码快照单文件最多10MiB、总量最多50MiB，不支持符号链接。产物写到 ${WORK_ROOT}/out/，可用 send_file 发送。` +
    `Code Mode 本身不提供 fetch、Node 或文件系统；需要联网、下载或处理文件时，自行编写 Node/Python/shell 脚本，通过 tools.write 保存，再由 tools.bash 执行，也可直接执行简短命令。Linux 沙箱网络可用，但不要下载大文件或安装大型依赖；单条命令最长 ${EXEC_MAX_TIMEOUT_MS / 1000} 秒，不要起常驻服务。主人私聊和群聊的普通消息回合可用，各会话写入与执行相互隔离；owner 会话可用 read({workspace:"group:群号",path:"/work/文件路径"}) 只读访问任意群工作区已保存的文件，不需要启动该群容器。workspace 仅用于 read，省略时仍读取当前工作区；群会话不能跨群读取。网页回合沿用所属会话的工作区与回复入口。read 返回 {kind:"text",text} 或 {kind:"image",image}；文本用 text(result.text)，图片必须 image(result.image) 输出。需要发图片时先用 read 查看文件，再直接调用模型工具 send_file({path:"/work/out/文件名"})，图片会作为图片段发送；send_file 不在 Code Mode 内调用。`;

export const CLOUDFLARE_RESOURCE_INSTRUCTIONS =
    " 使用 sandbox_list 查看可用 Cloudflare 工作区。主人可以用 sandbox_create 创建空工作区，或传 sourceId 复制其已保存源码（包括未提交到 Git 的文件）。复制不包含缓存、进程或系统安装状态。";

export const CLOUDFLARE_DELEGATED_INSTRUCTIONS =
  `所有沙箱工具只通过 Code Mode 调用。read 返回 {kind:"text",text} 或 {kind:"image",image}；分别用 text(result.text) / image(result.image) 输出。你的 Cloudflare Linux 沙箱工作目录为 ${WORK_ROOT}，工具固定路由到父 agent 分配的资源 ID。不要假定工作区独立，先核对分配说明。相对路径从 ${WORK_ROOT} 解析。` +
  `${WORK_ROOT} 内文件由宿主在 write / edit / bash 操作完成后自动快照提交到持久存储，只有提交成功才会在沙箱重建后恢复；持久化失败或结果不确定时不能宣称已保存，也不要盲目重跑。` +
  `新产生的 .git、node_modules、.wrangler 只留在当前容器，不进入源码快照；${WORK_ROOT} 外的文件、运行中的进程和系统环境修改也不在持久化范围内。产物放在 ${WORK_ROOT}/out/，在最终回答中说明路径，交由父 agent 处理。`;

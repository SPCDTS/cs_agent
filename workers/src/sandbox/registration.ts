import { EXEC_MAX_TIMEOUT_MS, WORK_ROOT } from "./client";

export const CLOUDFLARE_INSTRUCTIONS =
  `沙箱工具 read / write / edit / bash 仅经 Code Mode 的 await tools.<名称>(参数) 调用，默认作用于本会话 Debian 沙箱（含 python3、node、git、curl，目录限 ${WORK_ROOT} 内，无符号链接，单条命令最长 ${EXEC_MAX_TIMEOUT_MS / 1000} 秒，不起常驻服务或装大包；指定其他已授权资源传 sandboxId）。` +
  `空闲 3 分钟停止，已提交的 ${WORK_ROOT} 源码（单文件≤10MiB、总量≤50MiB）自动恢复，.git / node_modules / .wrangler 不入快照。` +
  `Code Mode 无内置 fetch/fs，联网或文件处理请写脚本经 bash 执行。read 返回 {kind:"text",text} 或 {kind:"image",image}，分别用 text(result.text) / image(result.image) 输出；image() 与超长输出返回独立的 r2:// 对象（临时输出保留 7 天）。r2_write({key,content}) 保存文本，传 path 代替 content 可上传工作区文件；r2_read({key}) 读取，owner 可传 sandboxId 核对子资源产物。指定 path 才复制到调用方的 /work 供 bash 使用，并在模型层调用 send_file({path,sandboxId?}) 发送。` +
  `owner 私聊可用 read({workspace:"group:群号",path:"/work/..."}) 只读群已存文件；群不能跨群读取。`;

export const CLOUDFLARE_RESOURCE_INSTRUCTIONS =
  " 用 sandbox_list 查看可用工作区；主人可用 sandbox_create 创建空工作区或传 sourceId 复制已存源码（不含缓存与进程）。";

export const CLOUDFLARE_DELEGATED_INSTRUCTIONS =
  `沙箱工具仅经 Code Mode 调用，工作目录限 ${WORK_ROOT}（路由至父 agent 分配的资源 ID，先核对是否共享）。read 返回 {kind:"text",text} 或 {kind:"image",image}，用 text(result.text) / image(result.image) 输出。` +
  `write / edit / bash 完成后自动快照持久化（不含 .git / node_modules / .wrangler、外部路径及进程）；持久化失败或未知时不得宣称已保存或盲目重跑。` +
  `临时输出为 r2:// 对象（保留 7 天）。r2_write({key,content}) 可独立保存文本或用 path 上传文件；r2_read({key,path}) 才会复制到 /work。汇报产物时附上 sandboxId 与路径或 r2:// 引用。`;

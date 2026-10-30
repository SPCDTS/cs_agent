# 云端能力对齐的私有迁移准备

本流程只读取旧数据和云端现状，生成本地私有备份、审阅计划与明确的dry-run。脚本没有apply模式，不上传素材、不替换生产数据库，也不提交私有正文或凭据。

## 文件与权限

通用脚本为`scripts/cloud-parity-migration.mjs`。旧数据目录、私有备份目录和管理员凭据文件都通过参数明确传入。凭据仅在内存读取，HTTP禁止重定向，只访问指定生产origin的管理接口。控制台只输出数量与SHA-256；persona、技能正文、授权身份、聊天内容和完整服务端响应均只写指定私有备份目录。

私有备份不进入Git。准备阶段保留persona原始字节、全部旧技能文件和云端5份技能快照，另外为install-skill与find-skills生成新正文。原文与配套文件均保留在备份；必要的Docker/全局安装命令改为工作区准备、skill_inspect检查与skill_publish的双版本CAS发布。其余技能不更新。

## 准备阶段

以下参数均为示例占位，替换为本次明确授权的本地路径：

```powershell
$env:NODE_USE_ENV_PROXY='1'
node scripts/cloud-parity-migration.mjs --mode prepare --source <旧data目录> --backup <私有备份目录> --token-file <admin-token.env路径> --origin https://agent.spcdts.dev
```

脚本只读agent.sqlite中kind为JSON字符串`"cs.grants"`的document及最新revision，不把pi.sqlite的其他document误作授权。导出保留原始expires_at、created_at与updated_at，不调用创建授权接口，不换成expires_in_hours。旧授权已过期时，导入后仍必须过期。记忆使用已经审核的memory-history.json，保留全部current、versions、links与proposals，由新历史导入API维护旧ID映射和幂等回执。

工作区只扫描文件元数据并生成分类报告，不读取全部素材正文、不上传任何文件。连续图片只作生成帧候选，其他图片与视频归为素材；超限文件单列。未选择的普通文件也不会自动进入工作集。单文件10MiB、工作区50MiB的预算不能通过静默截断或将素材转R2绕过。

## 等待部署后执行dry-run

必须先收到部署完成的明确通知，才运行下列命令。`--deployed`只是脚本保护开关，不能代替人类或父任务的部署确认。

```powershell
node scripts/cloud-parity-migration.mjs --mode dry-run --deployed --backup <同一私有备份目录> --token-file <admin-token.env路径> --origin https://agent.spcdts.dev
```

这一步重新只读云端现状，为persona和两份技能生成待审阅CAS请求，不执行PUT或发布。技能同时比对正文与配套文件的准备前散列；任何云端后写均标为冲突并保留云端。persona已有不同正文时也标冲突，不覆盖。新接口只允许以下两种POST，且body必须含dryRun:true：

- `/admin/grants/import`：原始授权、sourceHash和datasetId保持稳定，过期时间不变。
- `/admin/memory/history/import`：请求为`{data:history,dryRun:true}`，核对current、61份versions与4份links的新增/保留数量。

服务端完整回执保存在私有目录，控制台仅输出数量、状态数字和响应散列。dry-run通过之后仍须另行明确授权实际导入；本脚本没有执行生产更新的路径。不要在等待部署时自动重试新接口或启动任何工作区容器。

## 本次预期核对项

- persona：1份，原始2476字节，编码与换行在私有原件中原样保留。
- 技能：云端5份，仅2份准备迁移安装/发布说明，其他3份保持现状。
- 授权：旧document1份、grant1条且已过期，不重新激活。
- 记忆：current56条、versions61条、links4条、proposals0条。
- 工作区：7194个文件、762676176字节，仅分类，上传数量为0。

最终以私有migration-plan.private.json与dry-run-summary.private.json的数量和散列为准。当前工作区只存通用脚本和中文步骤，不存任何私有迁移正文。

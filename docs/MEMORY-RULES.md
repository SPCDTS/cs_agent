# 主人私聊回复约定（MVP）

## 边界

本功能不是权限系统。规则只约束主人私聊回复方式，不能改变工具权限、隐私、安全或发送授权；群、项目、独立子 agent 不继承这套规则。父线程处理子结果时，按自己的真实私聊目标读取。

普通 `kind=rule`、`active`、作者来源、正文里的“已批准”和模型工具调用均不代表批准。旧规则不自动启用，不迁移或批量批准真实数据。PR20 的画像复核、来源保护、有效期和承诺独立渲染保持不变。

## 管理流程

在主人记忆详情打开“规则批准 / 修改 / 撤销”：
1. 选择已配置主人的确切私聊，编辑正文与有效期，生成预览。
2. 核对精确 JSON 正文、作用域、memory version、binding revision 与 SHA256。
3. 单独点击“我批准以上精确版本和正文”。只有现有 Bearer 鉴权管理入口有此能力，未注册模型工具；schedule/event/subagent 没有审批入口。
4. 修改同样生成新提案，确认事务原子更新正文和批准。普通记忆编辑、替代、维护、恢复或删除不能修改仍受保护的条目。
5. 撤销需要 memory version 与 binding revision；普通遗忘受保护条目会被拒绝，先显式撤销再遗忘。恢复记忆数据不恢复批准。撤销本身（即使记忆正文未变）也让画像旧副本待复核。
6. 超时/结果未知先查相同 requestId 回执。相同输入重放返回原提交回执；同 ID 不同输入冲突。回执证明过去已提交，不代表当下仍启用。

API 前缀为 `/admin/memory/rules`，除 scopes 外，均要求 `?ns=owner&scope=private:<已配置主人>`。支持 scopes、bindings list、proposals、confirm、revoke、receipts/:requestId。批准身份由管理入口固定，参数不能指定 actor/origin/approved。管理读操作直接访问 owner DO 的真实数据，不使用可能滞后的镜像。

## 一致性与生效

- 新表独立追加，不改旧迁移；binding 绑定 memory_versions 的当前非历史导入版本及语义正文 hash，revision 防 ABA，epoch 只表示存储变更。
- 准入和读取均检查完整集合：每 scope 最多 24 条 enabled（含未来/已到期但未撤销条目），每条 500 字，完整编译最多 8192 UTF-8 字节；超限拒绝，不静默截断。
- 每 prepare 一致事务直读，不加规则缓存；按 ID 稳定排序，digest 不包含墙钟时间，since <= now < until；到期无需写库即不再选择。
- 独立 Pi `memory-rules` section 不依赖画像非空。相同文本无 patch，最后一条移除产生 null patch。正文 JSON 编码并转义尖括号。
- 写成功是 committed；下一次成功读取快照的 prepare 才是 rendered。已经准备的 cutoff、在途请求和已发输出不被追改；request 阶段恢复不能保证读到最新规则。
- 读库、预算或完整性故障返回明确 unavailable 替代块，不 throw 让 Pi 保留旧段。历史消息仍可能影响模型，这不是权限 fail-closed。
- 日志只报 rendered/unavailable、digest、epoch、ID/revision、字节数，不落规则正文；不把 renderer 日志宣称为 request-attached 或 followed。

数据库触发器阻断已启用条目的语义修改/删除，覆盖自动抽取、通用记忆工具、管理恢复、回滚与维护等写路径；专用批准事务内临时停用再更新，失败整体回滚。自动抽取对批准记录只生成候选。导入不能携带授权表，重复 ID 不覆盖现有条目；存在规则管理历史时，导入画像保持待复核，不能清除旧副本复核要求。已经进入规则管理的条目不再提供给自动画像建议，以免撤销后再抄回画像。

## 验收证据与限制

- `memory-rules.test.ts`：当前版本/正文确认、幂等与并发 CAS、ABA、作用域、导入/模型声称不自授权、写保护与恢复不复活、画像撤销复核、时间边界、条数/UTF-8 预算、完整性故障。
- `memory-rules-harness.test.ts`：真实 Workerd + Pi Harness，工具提交后续轮、原生压缩、关闭重开、读取故障替代与最后撤销；真实 request checkpoint 暂停/恢复保留旧 cutoff，下一 prepare 才读取新批准。
- `memory-rules-pi.node.mjs`：锁定 Pi 1.4.0 的实际 section planner，throw 保旧复现、稳定无 patch、null 删除、head baseline；两种 supportsMidConvoSystemMessages 配置实际 provider HTTP payload（全部网络本地 stub）。
- `memory-browser.node.mjs`：预览不会自动批准，单独确认绑定展示版本/正文。
- PR20 原有生命周期、抽取、管理和来源测试仍应完整通过。

以上是结构与本地合成运行测试，不是真实模型遵从率或 cached tokens 命中率，也不是生产部署验收。没有生产模型调用、真实数据迁移或用户规则修改。独立子任务继承、硬权限 prepare 门控与模型行为评估仍为后续阶段。

上线/关闭必须另获授权。关闭应保留数据库保护和审计，显式撤销后让下一 prepare 删除段；不能回滚到忽略新授权表的旧写代码。历史记录不会物理清除。

## 2026-11-17 独立审查修复

- F1：前向追加辅助字段更新及 memory_versions 插入保护触发器。批准绑定精确 memory version，因此即便 due_at / done_at 清空仍为 null，也拒绝普通写产生新版本；召回计数与时间仍可更新。专用确认事务在原子事务内临时停用对应绑定后更新版本，不受此限制。真实 ThreadDO/Harness 工具回归分别覆盖 dashboard、qq 作者，检查拒绝结果、版本/绑定/epoch/全量投影不变及召回成功。
- F2：规则编辑器由记忆详情的 namespace、详情代际、登录代际和 dialog 状态共同限定；内部 scope 请求再用独立序号隔离。每个异步响应、错误处理和按钮请求均复核生命周期，关闭、切记忆、切会话、退出登录后旧编辑器不能显示内容或发起后续请求。API 增加可选生命周期校验，避免迟到 401 清除新登录。
- 已经由有效页面提交的批准或撤销可能在关闭页面后完成；生命周期检查不撤回该在途事务，只阻止晚到响应污染新页面或旧控件发起额外操作。结果未知仍按原 requestId 查询回执，不自动重放。

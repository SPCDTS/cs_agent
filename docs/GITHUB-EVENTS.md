# GitHub App 事件接入

只支持独立 GitHub App。旧逐仓库手工 Webhook、名称白名单与首条事件 repo pin 已移除，不提供模式切换或旧 secret 兼容路径。不要复用开发 VM bot App 或凭据。

## 一次配置，后续只连接和勾选

完整 App 创建、权限、secret 与回调配置见 docs/GITHUB-APP-DESIGN.md。运营方只需一次配置独立 App：
- OAuth callback：`https://<PUBLIC_ORIGIN>/admin/github/oauth/callback`
- Setup callback：`https://<PUBLIC_ORIGIN>/admin/github/callback`
- 唯一事件入口：`POST https://<PUBLIC_ORIGIN>/github/webhook`
- 入口只用 `GITHUB_APP_WEBHOOK_SECRET` 验证原始 body；必需 App 配置缺失即 503，不回退。

owner 在管理台安装/调整 App 仓库权限，明确连接自己的 GitHub 身份，再勾选 installationId + repositoryId。服务端每次核验用户权限与本 App 安装权限的稳定仓库 ID 交集。仓库名仅显示和构建 GitHub 链接，不授权。多个身份与安装独立，事件只进入 owner；外部正文、路由字段都不是指令。

管理台每页十项、空选择保持空，打开中的草稿与 CAS 冲突不会被后台刷新覆盖。默认不监听任何仓库。事件动作沿用受控 CHOICES，不开放任意事件或命令。

## 持久收件和执行

- body 上限 256 KiB、流读取超时五秒。校验 content-type、有限 header、HMAC 后再解析。
- 普通事件必须有合法 installation ID；签名 ping 可确认 App 配置，但不授予仓库或安装权限。
- receipt 与 event_held 原子写入并同步后才 ACK；入口不运行模型，不轮询其他源。
- 所有业务、ping、生命周期共享唯一 bodyHash 去重域；修改未签名 delivery/event header 不能绕过去重。重复 body 返回 200，同 delivery 不同 body 返回 409。
- 最多 5000 receipts、200 pending；满载返回 503，不逐出未完成数据。超过三十天只清理 terminal receipts；失败需运营方在 App delivery 页面 Redeliver。
- 安装/仓库生命周期保守失效，只有显式同步权威 API 才能恢复；已抑制积压不会复活。
- 暂停保留积压；清空/失权抑制尚未获许可的数据。恢复执行时也必须有当前安装授权；已经实际运行的操作无法倒退。
- durable receipt/held/input key 与执行 ledger 保留。owner 普通消息不因暂停的 GitHub 输入阻塞；收件或 finished 状态不保证 QQ 已送达。

## 旧数据切换

旧手工配置和旧单行连接不会升级成 App 权限。旧名称或混合配置首次加载时转换为空 ID 选择、增加 revision；已连接身份的密文可以保留，但仍须 owner 明确重新勾选。旧 pin 表被移除，旧 receipts 保持可读。没有有效安装授权的旧 pending 会被抑制，旧 issued/finished 记录也不能被当作新的执行授权。旧 config 请求含 repositories 字段会被拒绝。

配置 App、连接身份、明确保存 ID 选择后，只接收新的有效 App 事件；不会恢复旧抑制积压。可关闭原逐仓库 Webhook，避免无意义拒收请求。本版本不再提供任何手工 Webhook 安装教程或运行路径。

## 验证边界

测试使用真实 Worker HTTP、EventsDO、SQL、HMAC、PKCE 与 AES-GCM，仅 mock GitHub HTTPS；覆盖旧 secret/config 拒收与拒执行，以及有效 App 流程、CAS、清空、全局去重、容量、崩溃恢复、暂停和 owner pump。真实独立 App/OAuth/组织 SSO/线上 Webhook 尚未联调。最新本地测试结果见交付记录。

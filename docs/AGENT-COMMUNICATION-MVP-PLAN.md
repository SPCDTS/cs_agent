# Agent 通信 MVP 实现计划

基线：c8ef3e5b4e19b156d62b518b02a166a5a7979a03（2026-11-22 API 核对 main，HTTPS fetch）。独立 worktree；不合并、不部署、不改生产配置。

1. 统一 runtime 注入 agentSessionId、单一 agent_send(to,text?,files?) 与最小消息信封；来源不可由模型填写。
2. 独立会话通信授权，默认拒绝；受控配置 owner 与 group:852131592 双向边，不按触发发言人判断。
3. Thread inbound / Subagent inbox / root.submit followUp 接入，不新增消息收件箱或生命周期状态机；旧 message/report 共用投递适配器。
4. 工作区文件固定快照、大小与敏感内容检查、目标 scope 副本及目标工作区持久化；不传裸源路径或跨 scope asset ID。
5. 增加来源/授权/重复 ID/忙时排队/文件读回/无 QQ 外泄与父子回归测试，运行完整 npm run check。
6. 提供代码 diff、检查记录、启用说明与未验证边界，交独立审查；没有真实部署验收就不宣称线上可用。

不纳入：新 cancel/wait/delegate、steer、复杂任务/回执状态机、任意群默认互通。

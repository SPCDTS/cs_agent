# Codex 0.163.0 线程恢复与插件开关调查

调查日期：2026-10-19。全部实验在 `cs_agent-runnerfix` worktree 的临时目录进行，没有访问容器或生产数据，也没有修改部署配置。

## 缺失线程的真实措辞

宿主机没有 `/usr/local/lib/node_modules/@openai/codex`。通过 `npm pack @openai/codex@0.163.0-win32-x64` 下载官方平台包到临时目录，解包后运行 `codex.exe --version`，输出 `codex-cli 0.163.0`。对包内 `vendor/x86_64-pc-windows-msvc/bin/codex.exe` 做字符串搜索，确认：

- `no rollout found for thread id `，例如二进制字节偏移 263577441。
- `no rollout found for conversation id `，二进制字节偏移 265615981。

两种措辞均由 `/no rollout found/i` 覆盖，测试分别使用两者。`thread/resume failed` 本身不表示线程缺失；JSON-RPC `code -32603` 明确按其他失败处理，保留原映射。

确认缺失时，沿用重置线程的归档写入器，先将旧记录、会话键、归档时间、`reason: "missing"` 和 stderr 尾部 300 字写入 `codex-threads-archive.jsonl`，再清除旧映射并新建线程。归档失败则保留原映射并报错。

## 插件开关实验

使用同一个 0.163.0 可执行文件，为两组实验分别创建全新的 `CODEX_HOME` 和 cwd；同时把实验子进程的 `HOME`、`USERPROFILE` 指向临时目录，避免加载真实用户的技能或配置。最小 `config.toml` 只有：

```toml
model = "gpt-6.1-sol"
```

没有复制凭据，没有登录。分别运行：

```text
codex debug prompt-input hello
codex debug prompt-input -c features.plugins=false hello
```

| 观察项 | 默认 | `features.plugins=false` |
| --- | --- | --- |
| 退出码 / stderr | 0 / 空 | 0 / 空 |
| `.tmp/plugins*`，含 sha、lock、clone 目录 | 均未出现 | 均未出现 |
| `<skills_instructions>` | 存在 | 存在 |
| 提示中的 `.system` 技能 | 保留 | 保留 |
| 自动写入 `CODEX_HOME` | `.sandbox`、`.sandbox_migration`、`installation_id`、`skills`、`tmp` | 相同种类 |

两组都安装了五个系统技能：`imagegen`、`openai-docs`、`review-agent`、`skill-creator`、`skill-installer`。归一化两组实验目录后，五条消息的提示正文完全一致。没有观察到关闭插件额外导致的错误或系统技能丢失；两组均有上述初始化落盘副作用。

结论仅限 Windows 0.163.0、未登录、未配置插件市场的干净环境。默认组也没有触发同步，因此本实验不能证明 `features.plugins=false` 能阻止生产环境的插件市场同步或解决其竞态，也未验证已安装插件的可用性变化。生产环境的插件开关保持原样。

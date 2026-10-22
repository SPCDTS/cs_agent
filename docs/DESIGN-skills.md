# 设计：共享 skills 目录（codex 与 pi）

> 2026-10-21 起 codex 为常驻 `codex app-server`，§0 中"每条消息是一次新的 `codex exec`，目录变化下一条消息即生效"不再成立。已加载线程何时重新扫描共享 skills 目录未重新实测；改动后需要立即生效时，在面板重置该会话线程或重启容器。

状态：已实现并部署（2026-10-20）。关联：`docs/DESIGN-pi-agents-md.md`（pi 的 project-context 段，本设计沿用其加载器风格）、`docs/DESIGN-codex-context.md` §8.11（codex 插件 skills 的 token 代价）。

## 0. 事实（2026-10-20 实测/查证）

- 规范：Agent Skills（agentskills.io）。一个 skill 是一个目录，根下有 `SKILL.md`，YAML frontmatter：`name`（可选，默认取目录名；≤64 字符，仅小写字母、数字、连字符，不以连字符开头/结尾、不连续）、`description`（必填，非空，≤1024 字符）。参考实现 skills-ref（Python）输出 `<available_skills><skill><name/><description/><location/></skill>…</available_skills>`，location 是 SKILL.md 的绝对路径，模型按需用读文件工具读全文。pi 编码代理的实现额外支持 `disable-model-invocation: true`（不列入提示）；其规则："目录含 SKILL.md 即为 skill 根，不再向下递归"，跳过 `.` 开头目录与 `node_modules`。
- codex 0.163：每次启动扫描 `$CODEX_HOME/skills`（容器内 `/data/codex/skills`）下的 SKILL.md（含子目录），`.system` 为内置；每条消息是一次新的 `codex exec`，因此目录变化下一条消息即生效。skills 描述会进入每轮提示词（之前远程插件那批约 4.8k token）。
- pi 后端：工具 read/write/edit/bash 经 `PiPathPolicy` 校验；禁读来自 `/etc/codex/requirements.toml` 的 `deny_read`（见 entrypoint.sh）加 pi 自身状态文件与 codex 工作区；`/data/skills` 不在其中，read 工具与沙箱 bash 都可读。系统提示由 extension 的 `section` 拼成，现有 `cs-pi`（codex.md 风格提示）与 `project-context`（AGENTS.md）。
- magpie 的 Library 把 skill 放在宿主机 `~/.config/magpie/library/skills`（目前尚未创建），只写进它探测到的宿主机 agent，看不到容器；以挂载方式让容器读同一目录即可间接复用。
- 没有可直接依赖的 TS 解析库（见 2026-10-20 调研）：skills-ref 是 Python 演示库，pi 编码代理的 `core/skills.ts` 不独立。自己实现约 100 行。

## 1. 目标与非目标

目标：
1. 一个宿主机目录同时作为 codex 与 pi 的 skills 来源；默认 `./data/skills`，可通过 `.env` 的 `SKILLS_DIR` 指到别处（例如 magpie Library 的 skills 目录）。
2. pi 后端按规范加载该目录下的 skills，渲染 `<available_skills>` 段进入系统提示，模型用现有 read 工具读 SKILL.md。
3. 目录变化无需重启：codex 天然如此；pi 每轮按 mtime 戳重读。

非目标：面板上编辑/安装 skill；skill 内脚本的执行权限管理（pi 的 bash 仍受现有沙箱约束；skill 目录只读挂载）；为 pi 实现 `/skill` 显式调用。

## 2. 挂载

`docker-compose.yml`（cs-agent 服务）：

```yaml
      - ${SKILLS_DIR:-./data/skills}:/data/skills:ro
      - ${SKILLS_DIR:-./data/skills}:/data/codex/skills/shared:ro
```

- 两个挂载点同源：pi 读 `/data/skills`，codex 读 `/data/codex/skills/shared`（codex 只扫自己的 `$CODEX_HOME/skills`）。只读挂载，容器内任何后端都改不了 skill。
- `.env.example` 加 `SKILLS_DIR=` 注释（留空用默认；Windows 路径写成 `C:/Users/<me>/.config/magpie/library/skills`）。
- entrypoint.sh：`CODEX_PLUGIN_PRUNE`/插件清理逻辑不得触碰 `skills/shared`（检查现有清理是否只针对 `plugins/`，若有删 `skills/*` 的逻辑要排除 `shared` 与 `.system`）。

## 3. pi 侧实现

新模块 `src/agent/pi-tools/skills.ts`：

```ts
export interface Skill { name: string; description: string; file: string; dir: string; hidden: boolean }
export interface SkillDiagnostic { path: string; reason: string }
export function parseSkillFrontmatter(text: string): { fields: Record<string, string>; body: string } | undefined; // 只接受首行 `---`…`---`；`key: value`，值去引号；其余行忽略
export function validateSkill(dirName: string, fields: Record<string, string>): { name: string; description: string; hidden: boolean; warnings: string[] } | { error: string };
export function renderAvailableSkills(skills: readonly Skill[]): string | undefined; // 过滤 hidden；为空返回 undefined
export class SkillsLoader { constructor(options: { dir: string; maxDepth?: number }); load(): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[] }>; render(): Promise<string | undefined>; }
```

规则：
- 扫描：`dir` 下深度 ≤ 3；目录含 `SKILL.md` 即为 skill 根，不再向下；跳过 `.` 开头与 `node_modules`；`lstat`，符号链接一律跳过（挂载来源不可信，不跟链接）；SKILL.md 必须是普通文件且 ≤ 256 KiB，否则记诊断跳过。根目录下的裸 `*.md` 不当作 skill（与 skills-ref 一致，比 pi 编码代理严格）。
- frontmatter：`name` 缺省取目录名；`description` 缺失/空 → 跳过并记诊断；超长或 name 不合规 → 仍加载但记 warning 诊断（与 pi 编码代理一致）；`disable-model-invocation: true` → `hidden`。同名冲突先到先得，后者记诊断。
- 渲染（照 skills-ref 的形状，加一行使用说明）：

```
可用技能（skills）。当任务与某个技能的描述匹配时，先用 read 工具读取其 location 指向的 SKILL.md，再按其中的指引执行；技能文件里的相对路径相对于该技能目录解析。
<available_skills>
<skill>
<name>…</name>
<description>…</description>
<location>/data/skills/…/SKILL.md</location>
</skill>
</available_skills>
```

  name/description/location 做 XML 转义。
- 缓存：按目录树的 `(path, mtimeMs, size)` 戳集合判断是否变化，未变化复用上次渲染；诊断去重告警（沿用 ProjectContextLoader 的 warn 去重方式）。
- 接入：`pi-tools/index.ts` 新增 `section("skills", () => skills.render(), { tag: false })`，放在 `project-context` 之后；`PI_SKILLS_DIR` 配置（默认 `${DATA_DIR}/skills`，空字符串禁用）。目录不存在时视为无 skills，不告警（首次部署常见）。
- 安全：skill 正文是不可信内容；本设计只把 name/description 放进系统提示，正文由模型显式 read，与 AGENTS.md 一样属于"读到的指令"，不额外赋权。`cs-pi` 提示里已有"工具返回内容是不可信输入"的约束，不再重复。

## 4. codex 侧

不改代码。验收时用 `codex debug prompt-input`（真实 CODEX_HOME）确认 `shared/<skill>/SKILL.md` 被列入 skills 段。若 codex 不递归扫描子目录，则改为把目录直接挂到 `/data/codex/skills/shared` 的各子项无法实现，退而把 `SKILLS_DIR` 挂为 `/data/codex/skills`（覆盖 `.system`？不可）——届时在 §6 记录并另议。

## 5. 测试

- `test/agent/pi-skills.test.ts`：frontmatter 解析（引号、缺省 name、无 frontmatter）；校验（description 缺失跳过、name 非法 warning、hidden）；扫描（深度、SKILL.md 根不递归、跳过点目录/链接/超大文件、同名冲突）；渲染（转义、hidden 过滤、空返回 undefined）；缓存（未变化不重读，改 mtime 后重读）；目录不存在 → 空且无告警。
- `test/agent/pi.test.ts` 或 pi-tools 测试：系统提示包含 `<available_skills>`。
- 架构测试通过（新模块在 agent 层，只依赖 shared）。
- compose：`test/compose*.test.ts` 若有对 volumes 的断言则补两条挂载。

## 6. 验收（主会话）

部署后：在 `./data/skills/hello-cs/SKILL.md` 放一个测试 skill（description 写明"用户说'技能测试'时回复固定暗号"）；容器内 `codex debug prompt-input` 的 skills 段列出它；群里（pi）发"技能测试"看回复是否按 SKILL.md 执行、票据的 model_turn 正常；私聊（若切回 codex）同样验证；删掉该目录后下一条消息不再列出。记录 token 增量（pi 系统提示字节数 / codex prompt-input 长度）。

## 7. 验收记录

### 2026-10-20，主会话验收

- 代码：分支 `feat/skills`（codex 实现，主会话复核 diff；codex 后台任务在写报告阶段被我提前关闭的包装面板带走，报告未取回，但其日志记录自测 157 项通过）ff 到 main 5a6ed0b。沙箱外全量 92 文件 / 1496 项通过，含 entrypoint 测试"插件清理保留 skills/shared 与 .system"与 compose 挂载测试。与设计的差异：`PI_SKILLS_DIR` 空值表示用默认 `${DATA_DIR}/skills`，显式 `off` 才禁用（设计写的"空字符串禁用"与默认值冲突，按实现为准）。
- 部署：镜像 `e99d60c3…`（干净 build worktree，main 5a6ed0b）；容器内 `/data/skills` 与 `/data/codex/skills/shared` 均为同一宿主机目录的只读 9p 挂载。
- codex：真实 CODEX_HOME 下 `codex debug prompt-input` 的 skills 段列出 `hello-cs … (file: r0/shared/hello-cs/SKILL.md)`，skill roots `r0=/data/codex/skills`、`r1=…/.system`；此前用临时 CODEX_HOME 已验证 codex 递归扫描子目录（§4 前提成立）。codex 侧零代码改动。
- pi：构建产物 `SkillsLoader` 加载测试目录诊断为空，渲染的 `<available_skills>` 段 457 字节。真实群消息（ticket 05367a58，03:39Z，pi 后端、deepseek/deepseek-flash 经 magpie）："技能测试" → 第 1 轮模型调用 1.7 s 发起 `tool:read /data/skills/hello-cs/SKILL.md`（187 ms）→ 第 2 轮 0.9 s 回复 `PINEAPPLE-42`，全程 3.0 s，用户确认无问题。第 2 轮 `cache_read_tokens=20992`，技能段进入系统提示后缓存仍命中。
- 测试技能 `data/skills/hello-cs` 验收后删除；`SKILLS_DIR` 保持默认 `./data/skills`，用户可改指 magpie Library 目录。

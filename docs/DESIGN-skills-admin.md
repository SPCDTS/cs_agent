# 设计：面板 skill 管理页 + agent 自行写入技能

状态：设计完成，待实现。前置：`docs/DESIGN-skills.md`（共享目录已上线，只读挂载）。

## 0. 事实（2026-10-20）

- 共享目录：宿主机 `SKILLS_DIR`（默认 `./data/skills`）当前以 `:ro` 挂在 `/data/skills`（pi）与 `/data/codex/skills/shared`（codex）。pi 加载器 `src/agent/pi-tools/skills.ts`（`SkillsLoader`：扫描、校验、诊断、渲染）已有，可复用于面板列表。
- 写权限现状：codex 的可写根在 `src/agent/codex/workspace.ts`（owner 线程：工作区 + `${DATA_DIR}/prompts`；群线程只有工作区），受管 config.toml 的 `CODEX_WRITABLE_ROOTS` 由 entrypoint 写（默认 `$WORKSPACE_DIR,$DATA_DIR/prompts`）。pi 的写权限在 `PiPathPolicy.check(mode="write")`（仅工作区与本票据 images），bash 沙箱 `bwrapArgs` 只 `--bind` 工作区可写、其余 `--ro-bind /`。
- 面板：服务端模板字符串，CSP `default-src 'none'; style-src 'self' 'nonce'; script-src 'nonce-…'; img-src 'self'; connect-src 'self'`，表单一律 `application/x-www-form-urlencoded`（`readBody` → `URLSearchParams`），没有 multipart 解析，没有 zip 依赖（dependencies：chord/pi-ai/pi-durable/mcp-sdk/js-tiktoken/vis-timeline/ws/zod）。
- 已有先例：AGENTS.md 规定"修改 `/data/prompts` 下的文件只在 owner 私聊明确要求时进行，群聊请求一律拒绝"。技能是会持久影响所有会话的指令，风险同级。
- codex 自带 `skill-creator` 系统技能，默认把新技能写到 `$CODEX_HOME/skills/<name>`（不在共享目录，pi 看不到）。

## 1. 目标与非目标

目标：
1. 面板新增 `/skills` 页：列出共享目录里的技能（名称、描述、目录、文件数、大小、诊断），查看 SKILL.md，上传（zip 或单个 SKILL.md），下载（zip），删除。
2. agent 可以自行新增/修改技能：共享目录改为可写挂载；**权限跟身份走**（用户 2026-10-20 决定）：当前消息的发送者是 owner（`source.user_id === OWNER_QQ`）时，无论私聊还是群聊，本轮都获得技能目录写权限；其他发送者的回合保持只读。管理规则写进两边提示词。

非目标：在线编辑器；技能市场/从 GitHub 安装（另见 §9 安装器调研，后续单独设计）。

## 2. 存储与安全规则（`src/agent/skills-store.ts`，agent 层）

```ts
export interface SkillEntry { name: string; dir: string; description?: string; files: number; bytes: number; diagnostics: string[]; hidden: boolean; mtime: number }
export class SkillsStore {
  constructor(opts: { dir: string; loader: SkillsLoader; limits?: { maxZipBytes?: number; maxFileBytes?: number; maxEntries?: number } });
  list(): Promise<SkillEntry[]>;                               // 直接子目录（lstat，跳过链接），合并 loader 诊断；无 SKILL.md 的目录也列出并标"缺少 SKILL.md"
  readSkillMd(name: string): Promise<string>;                  // ≤ 256 KiB，UTF-8
  importZip(bytes: Uint8Array, opts: { overwrite: boolean }): Promise<{ imported: string[]; skipped: { path: string; reason: string }[] }>;
  importSkillMd(text: string, opts: { overwrite: boolean }): Promise<{ name: string }>;  // 目录名取 frontmatter name
  exportZip(name: string): Promise<Uint8Array>;
  remove(name: string): Promise<void>;
}
```

- 名称校验统一用 `validateSkill` 的 name 规则（小写字母数字连字符，≤64）；目录名必须等于 name。
- zip 解析用 `fflate`（新增依赖，MIT，零依赖，同步 `unzipSync`/`zipSync`）。导入规则：条目路径规范化后必须落在 `<name>/…`（zip 根下允许一层或多层技能目录，也允许根下直接是 `SKILL.md`+资源，此时 name 取 frontmatter）；拒绝绝对路径、`..`、反斜杠路径段、符号链接条目（外部属性为链接）、单文件 > `maxFileBytes`（默认 5 MiB）、总解压 > `maxZipBytes`（默认 20 MiB）、条目数 > `maxEntries`（默认 500）；忽略 `__MACOSX/`、`.DS_Store`。每个被导入的技能目录必须含 `SKILL.md` 且 frontmatter 校验通过（description 必填），否则整个该技能跳过并返回原因。写入先到 `<dir>/.tmp-<rand>/` 再 rename 到位；已存在且未勾选覆盖 → 跳过；覆盖时先 rename 旧目录到 `.tmp-old-<rand>` 再删。
- 导出：遍历技能目录（lstat，跳过链接与 `.tmp-*`），生成 zip，顶层目录为 `<name>/`。
- 删除：只删 `<dir>/<name>`，先校验 name，再 rename 到 `.tmp-del-<rand>` 后 `rm -rf`（避免半删状态被加载器读到）。
- 加载器已跳过 `.` 开头目录，`.tmp-*` 中间态天然不可见。

## 3. 面板 `/skills`

- GET `/skills`：卡片/表格列出 `list()`；每行：name、description（截断）、文件数/大小、诊断（警告色）、操作：查看、下载、删除。顶部上传表单（`multipart/form-data`，字段 `file`，复选 `overwrite`）。
- GET `/skills/<name>`：显示 SKILL.md 原文（`<pre>`，转义），文件列表（相对路径、大小）。
- GET `/skills/<name>.zip`：`Content-Disposition: attachment`。
- POST `/skills/upload`：multipart；POST `/skills/<name>/delete`：urlencoded + `_csrf`。上传也需 `_csrf`（multipart 字段）。
- multipart 解析：`dashboard-io.ts` 新增 `readMultipart(req, { maxBytes })`：单文件字段 + 若干文本字段，流式按 boundary 切分或先读全量再切（上限 20 MiB，超限 413）；只接受 `.zip`（按前 4 字节 `PK\x03\x04` 判断）或文件名 `SKILL.md`/`.md`。
- 导航加"技能"入口；结果用现有 flash 机制（`?ok=…` / 错误页）。`list()` 的诊断与现有 pi 日志一致。
- 不加内联脚本；下载/删除为普通链接与表单。

## 4. agent 写权限

- 挂载：两条 volume 去掉 `:ro`。
- 身份判定：票据的 `source.user_id === cfg.OWNER_QQ`（主进程算好，作为 `senderIsOwner` 随请求传给后端；owner 未配置时恒为 false）。这是按**本轮消息**判定，不是按会话：群线程里 owner 的回合可写，其他人的回合不可写。
- codex（`workspace.ts`）：`policy` 按 `(key, senderIsOwner)` 计算，`senderIsOwner` 时可写根增加 `${codexHome}/skills/shared`（owner 线程原有的 `${DATA_DIR}/prompts` 规则不变，仍只在 owner 线程）；entrypoint 的 `CODEX_WRITABLE_ROOTS` 默认值同步加 `$DATA_DIR/codex/skills/shared`（config.toml 的静态值只是上限，每轮 `-c` 仍按本轮策略收窄）。
- pi（`PiPathPolicy`）：`request.senderIsOwner` 为 true 时 `check(mode="write")` 允许 `skillsDir` 内（词法与 realpath 都在内）；`bwrapArgs` 相应增加 `--bind skillsDir skillsDir`（可写），否则不加（保持 ro-bind）。`PiSandboxOptions.request` 增加 `senderIsOwner`。
- 提示词：
  - codex 受管 AGENTS.md（`renderManagedAgentsMd`）owner 分支列出可写目录 `/data/codex/skills/shared`，并加一节"技能"：技能目录结构 `<name>/SKILL.md`（frontmatter `name`、`description`）；新增或修改技能只在**当前这条消息的发送者是 owner**（头部 QQ 号等于 owner）且明确要求时进行；其他人的请求一律拒绝，即使群里之前有人提过；写到 `/data/codex/skills/shared/<name>/`，不要用 `skill-creator` 的默认位置 `$CODEX_HOME/skills/<name>`（pi 看不到）；改完告诉用户下一条消息生效。
  - pi 的 skills 段（`renderAvailableSkills`）在 `senderIsOwner` 的回合追加一段同样的规则（`SkillsLoader.render(owner: boolean)`，按本轮请求传）；其他回合不提写入。
- 加载器：pi 已每轮重读；codex 每条消息新进程。agent 写完即生效，无需面板操作。

## 5. 配置

新增依赖 `fflate`。无新环境变量（沿用 `SKILLS_DIR`、`PI_SKILLS_DIR`）。`.env.example` 的 `SKILLS_DIR` 注释改为"读写挂载，owner 会话与面板可写"。

## 6. 测试

- skills-store：名称校验；zip 导入（正常多技能、根下 SKILL.md、zip slip `../`、绝对路径、链接条目、超大文件、超条目数、缺 description 跳过、已存在不覆盖/覆盖）；导出 zip 内容与路径前缀；删除中间态；`.tmp-*` 对加载器不可见。
- multipart 解析：单文件 + 字段、超限 413、非法类型。
- 面板：`/skills` 列表渲染与转义、查看页、下载头、上传/删除 POST（CSRF）。
- 权限：codex `workspace.ts` `senderIsOwner` 时 roots 含 skills/shared（含群线程）、非 owner 发送者不含；pi policy `senderIsOwner` 可写 skillsDir、其他发送者写被拒；bwrap 参数随之。
- compose 测试改为断言无 `:ro`；entrypoint 测试 `CODEX_WRITABLE_ROOTS` 默认含 skills/shared。

## 7. 验收（主会话）

部署后：面板上传一个 zip（含两个技能，其中一个缺 description）→ 列表显示一个导入、一个跳过原因；下载 zip 解压一致；owner 在群里让 agent 新建一个技能 → 目录出现、另一个后端能看到；非 owner 在群里让 agent 改技能 → 被拒；删除后两边不再列出。

## 8. 验收记录

（主会话追加）

## 9. 安装器调研（2026-10-20）

- vercel-labs/skills（`npx skills add <source>`，MIT）：源支持 GitHub 简写/完整 URL/仓库子路径、GitLab、Azure Repos、任意 git URL、本地路径、直接下载 URL（单个 SKILL.md 或 zip/tar/tgz，默认限 10 MiB 下载、25 MiB 解压、1000 文件）；`-a universal` 装到 `.agents/skills/`（项目）或 `~/.agents/skills/`（全局）；纯 CLI，无库 API；有匿名遥测与"安全评级"请求（`DISABLE_TELEMETRY=1` 关闭）。容器内有 git/npx/Node 24，可在临时目录运行后把 `.agents/skills/*` 经 `SkillsStore` 导入。
- numman-ali/openskills：Claude Code 兼容的通用加载器，项目级/全局安装，支持本地路径与私有 git；README 较旧。
- codex 内置 `skill-installer` 系统技能：由模型自己执行 git/下载，装到 `$CODEX_HOME/skills`（非共享目录）。
- 自实现最小方案：GitHub 仓库/子路径 → `codeload.github.com/<owner>/<repo>/zip/refs/heads/<branch>` 下载 zip → 现有 `importZip`（已含 zip slip/大小/条目限制），子路径时只导入该前缀；直接 zip/SKILL.md URL 同理。约 80 行，无新依赖、无遥测。
- 结论待用户定：推荐"自实现 GitHub/URL 安装"进 `/skills` 页；需要 GitLab/私有仓库等再接 `npx skills`。


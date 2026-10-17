# 生图工具 v2 验收记录

日期：2026-10-18（Asia/Shanghai）。依据设计 §4.9 与用户后续原生 RGBA 决定。

## 结果与边界

- 实现参数校验、21 个尺寸预设、内联选项、动态 Qwen 图、MCP/HTTP 后端、QQ 参考图下载与恢复、7 天清理、IMAGE_REFS 允许列表，以及中文提示词与部署说明。
- typecheck、完整 Vitest（24 文件 / 312 测试）、build、`docker build -t cs-agent:imgv2 .` 全部退出 0。
- 未停止、重启或替换运行中的 Docker 容器；未修改 `.env`、`docker-compose.yml`、`docker/seccomp-codex.json`、`docs/DESIGN-codex-context.md`；未调用真实 Codex、语言模型代理或 QQ；没有下载模型。
- 真实生成仅通过宿主机 `COMFY_MODE=http`、`http://127.0.0.1:8188`，共 5 个 prompt_id：普通 1MP、宽图、2K、透明和单图编辑各一次。
- 现有 `.env` 若仍设置 `COMFY_WORKFLOW_FILE`，会继续走自定义图。部署新功能时应由运维清空覆盖值；本次仅更新 `.env.example` 默认值，没有部署。

## 实际节点接线

公共模型：UNET `qwen_image_2.1_turbo_int8_convrot.safetensors`，CLIP `qwen3vl_8b_w4a8.safetensors`（type=qwen_image），VAE `qwen_image_2.1_vae_bf16.safetensors`。

| 生成器节点 | 接线 |
|---|---|
| 1 UNETLoader | MODEL → 6 KSampler.model；启用 COMFY_QWEN_CACHE 时先经 10 QwenImage21Cache（auto/default） |
| 2 CLIPLoader | CLIP → 4 TextEncodeQwenImage21.clip |
| 4 TextEncodeQwenImage21 | slot 0 → 6.positive；slot 1 → 6.negative；prompt、negative_prompt、resolution 按参数填写 |
| 5 EmptyLatentImage（文生图） | width/height 取预设，batch_size=count；LATENT → 6.latent_image |
| 20、21、22 LoadImage（编辑） | IMAGE → 4 的 images.image_1、images.image_2、images.image_3；加载名字为上传后票据子目录内的文件名 |
| 3 VAELoader（编辑） | VAE → 4.vae；编码器 slot 2 的 LATENT → 6.latent_image。count>1 经 5 RepeatLatentBatch(amount=count) 后再接 6 |
| 6 KSampler | 8 步、CFG 1、euler、simple、denoise 1；LATENT → 7 VAEDecode.samples |
| 3 VAELoader（解码） | VAE → 7.vae |
| 7 VAEDecode | IMAGE → 8 SaveImage（普通），或 8 SaveImageAdvanced（透明：png、8-bit、sRGB） |

编辑时不使用 EmptyLatentImage：输出画布取编码器的参考图 latent，保持首张参考图比例。resolution 为目标预设面积平方根取最近 32 倍数，控制像素预算。透明请求附加透明背景/alpha 提示，解码使用原生 2.1 VAE。官方模板负面提示说明指出 CFG=1 时 negative_prompt 不产生 CFG 引导效果；接口仍完整传入，未改变用户指定的 Turbo 固定采样参数。

官方模板目录：`D:/Tools/ComfyLocal/.venv/Lib/site-packages/comfyui_workflow_templates_json/templates/`。以下为本机文件的 1-based 行号：

| 模板 | 行号与依据 |
|---|---|
| image_qwen_image_2_1_turbo_image_edit.json | 1251：节点 474 TextEncodeQwenImage21；1130：节点 468 ComfySwitchNode，默认 false；2227：link 724 从 474 slot 2 到开关 false；2339：link 913 从开关到采样器 505 的 latent；2443：link 710 输入参考图；2451：link 720 把 VAE 接编码器 |
| image_qwen_image_2_1_background_removal.json | 197：节点 461 SaveImageAdvanced，widgets 为 png/8-bit/sRGB；1011：节点 457 VAEDecode；1523：link 649 VAE → decode；1531：link 650 decode → 子图输出；1539：link 651 KSampler → decode；390：顶层 link 672 把子图 459 的 IMAGE 接 461 |
| image_qwen_image_layered.json | 2731：节点 128 EmptyQwenImageLayeredLatentImage；2152、2666：另一套 VAE/UNET；2326、2381、2435：LatentCut、LatentCutToBatch、VAEDecode。此链未采用 |

与原设计偏差：layered 是 5D/16 通道 latent，Qwen Image 2.1 是 4D/64 通道；混用会维度/通道不匹配。按用户后续决定采用原生 RGBA 链，普通 EmptyLatentImage 由 2.1 采样路径适配，无 layered 节点。当前所需模型全部存在，无需下载清单或额外 RGBA VAE。缺失 VAE 的自检/提交错误已有测试：`透明输出未启用：缺少 qwen_image_2.1_vae_bf16.safetensors`，程序不自动下载。

## 真实 ComfyUI 冒烟

使用 `scripts/smoke-image-v2.mjs`，结果和可恢复任务状态保存在 `data/imgv2-smoke/`。时间为客户端从提交前到成功下载的墙钟时间，包含排队、上传、收取与下载；2K 包含一次超时后的重新收取间隔，不是纯 GPU 时间。

| 用例 | 输出尺寸 | 字节 | 总耗时 | 结果 |
|---|---:|---:|---:|---|
| 1MP 文生图 | 1024×1024 | 1,575,169 | 15.242 s | PNG；橘猫与蓝杯 |
| 16:9 | 1344×768 | 1,398,411 | 40.405 s | PNG；宽图预设正确 |
| 2K | 2048×2048 | 4,568,196 | 388.056 s | PNG；首次 240 s 收取超时，按同一 ID 继续成功 |
| 透明 | 1024×1024 | 1,022,944 | 17.151 s | RGBA；alpha 范围 0–255 |
| 单图编辑 | 1024×1024 | 1,696,459 | 14.160 s | 上传首张生成图；蓝杯变红杯，猫的姿态与构图基本保留 |

透明 PNG 用本机 Pillow 直接读取 alpha：完全透明 318,991 像素，部分透明 583,949 像素，完全不透明 145,636 像素，合计 1,048,576。不是只检查 IHDR 的 RGBA 标记。

输出文件（均位于 `data/imgv2-smoke/`，未纳入 Git）：

```text
t2i/imgv2-t2i-1792264874428_00001_.png
wide/imgv2-wide-1792264889671_00001_.png
2k/imgv2-2k-1792264930077_00001_.png
transparent/imgv2-transparent-1792265318134_00001.png
edit/imgv2-edit-1792265335285_00001_.png
```

对应 prompt_id：

```text
t2i         97f3e9b8-3637-44f4-b149-7a0b8199f7d8
wide        c7b29569-dc26-4e4f-85f3-0314b54d49c7
2k          8fd451e1-e694-4222-9af2-a138a3edd732
transparent d4eefe79-cd29-4b71-b118-cbaf7755bbe0
edit        e4cdcfa3-6e16-4c9e-8bf7-bc9d70ae709e
```

## 验证输出尾部（原文）

`npm.cmd run typecheck`：

```text
> cs-agent@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit
```

`npx.cmd vitest run`（日志 `data/imgv2-work/npx-vitest.log`）：

```text
 Test Files  24 passed (24)
      Tests  312 passed (312)
   Start at  03:35:55
   Duration  29.45s (tests 90%, import 9%, transform 1%)
```

`npm.cmd run build`：

```text
> cs-agent@0.1.0 build
> tsc -p tsconfig.json
```

`docker build -t cs-agent:imgv2 .`：

```text
#26 exporting manifest list sha256:dff7049792adffc5bc4886a68c148f3348e518559a7ea49efc7dde7dade7377f 0.0s done
#26 naming to docker.io/library/cs-agent:imgv2 done
#26 unpacking to docker.io/library/cs-agent:imgv2 0.1s done
#26 DONE 0.5s

View build details: docker-desktop://dashboard/build/desktop-linux/desktop-linux/j60awrvbhtxp57h4jlqo3fsll
```

Windows 沙箱拒绝 Docker 及测试用 taskkill，最终测试/镜像构建在获准的沙箱外执行；没有改动生产进程。Docker 构建退出 0，npm 报告 0 vulnerabilities，另有两个依赖安装脚本未列入 allowScripts 的警告（非失败）。

## 已知限制与未验证项

- NapCat：核对了 [array 图片段源代码](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/api/msg.ts) 和 [URL 刷新说明](https://napneko.github.io/develop/file)。一般包含 url/file/file_size，但 disableGetUrl 配置可能只给本地路径。本次禁止真实 QQ 调用，因此本机上报设置未实测；无法获得 HTTP URL 时明确失败，不读取宿主机文件。
- comfy-mcp：本机 `comfy_mcp/server.py:10312` 的 `upload_file(paths, overwrite=False)` 没有 subfolder。为保证票据子目录隔离，使用同 URL HTTP 上传回退；该 HTTP 路径已真实编辑验证。支持 subfolder 的 MCP 分支由假服务覆盖，没有宣称本机真实 MCP 上传已验证。
- 2K：16 GiB GPU 本次超出 240 秒预算；保留规范要求的像素线性预算和上限，没有擅自延长。正常任务超时不会取消 ComfyUI 服务器任务；冒烟脚本按已保存 ID 继续收取。
- 多图参考、count>1、2mp、缓存开关以单元/快照/假服务覆盖；未额外消耗真实生成额度做组合测试。
- pi 后端仍是仓库原有第 3 组占位。统一 schema、后端接口、参考图校验和 agent.md 模板可复用，但没有补做整套 pi 模型执行工具循环。
- 入站下载完成后才写票据；下载期间进程崩溃仍依赖 OneBot 重投才能重新接纳该消息。已写票据的 source_images 随恢复重用，参考图超过 7 天清理后不保证旧编辑任务可恢复。
- 参考图 7 天保留只清理本机 incoming；上传到 ComfyUI input 的副本不在本项目清理范围内。

## 文件清单

下列文件按实现、测试、文档分组；提交记录见最终交付报告与 Git 历史。

实现与脚本：

```text
.env.example
scripts/entrypoint.sh
scripts/smoke-image-v2.mjs
src/agent/backends/codex.ts
src/agent/backends/types.ts
src/agent/codex-runner.ts
src/agent/dispatch.ts
src/agent/docs.ts
src/agent/image-gen.ts
src/agent/image-options.ts
src/agent/image-references.ts
src/agent/prompt.ts
src/agent/qwen-workflow.ts
src/agent/router.ts
src/agent/tasks.ts
src/config.ts
src/context/aging.ts
src/main.ts
src/mcp/image-gen-server.ts
src/mcp/image-gen.ts
src/qq/bridge.ts
src/qq/incoming.ts
src/qq/policy.ts
src/qq/reply-store.ts
src/qq/types.ts
```

测试与快照：

```text
test/agent/__snapshots__/image-options.test.ts.snap
test/agent/codex-runner.test.ts
test/agent/dispatch.test.ts
test/agent/fixtures/fake-comfy-mcp.mjs
test/agent/image-backend-v2.test.ts
test/agent/image-gen.test.ts
test/agent/image-options.test.ts
test/agent/image-references.test.ts
test/agent/prompt.test.ts
test/agent/router.test.ts
test/config.test.ts
test/context/aging.test.ts
test/context/store.test.ts
test/entrypoint.test.ts
test/mcp/image-gen.test.ts
test/mcp/qq-context.test.ts
test/qq/incoming.test.ts
test/qq/reply-store.test.ts
```

文档：

```text
docs/ARCHITECTURE.md
docs/DEPLOY.md
docs/IMAGE-GEN-V2-ACCEPTANCE.md
```

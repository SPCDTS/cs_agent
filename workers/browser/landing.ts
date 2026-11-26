import { JOULE_PIXELS } from "./joule-pixels";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

type NodeMeta = { name: string; role: string; tags: string[] };
type SeqMeta = { badge: string; text: string; tags: string[] };
type CompareEntry = {
  colLabel: string;
  summary: string;
  concession: string;
  rows: readonly [dim: string, other: string, ours: string][];
};

const nodeMeta: Record<string, NodeMeta> = {
  "in-onebot": {
    name: "/onebot & /media/",
    role: "接收 OneBot v11 消息、通过 get_file/file_id 直存附件到 /work，并处理 Codex 扫码配对（64 KiB JSON 上限）。",
    tags: ["QQ_OWNER 鉴权", "qq_attachment 直存", "Codex 配对"],
  },
  "in-admin": {
    name: "/admin/ & /mcp/reverse/*",
    role: "管理台前端与只读 API、Cloudflare PKCE 授权，以及 /mcp/reverse/<id> 反向 WebSocket 节点注册。",
    tags: ["Bearer Token", "Reverse WS 16会话", "CF 账户授权"],
  },
  "in-hooks": {
    name: "/github/webhook & /gmail/pubsub",
    role: "接收多身份 GitHub App 事件与 Gmail Pub/Sub 推送，经三层去重配额后投递 owner 主线程。",
    tags: ["多身份 GitHub", "Gmail Pub/Sub", "三层去重"],
  },
  "in-cron": {
    name: "Workers Cron",
    role: "按 */5 * * * * 与 UTC 19:30 周期驱动定时任务、发送限速 tick、R2 分页 GC 与每日记忆整理。",
    tags: ["*/5 * * * *", "UTC 19:30", "分页 GC"],
  },
  "do-bridge": {
    name: "BridgeDO",
    role: "唯一 QQ 边界守门人：维护 NapCat 反向 WS、聊天目录、发送熔断与 5,000 条持久化发送账本。",
    tags: ["Single-Owner", "reconcile 核对", "禁 unknown 重放"],
  },
  "do-thread": {
    name: "ThreadDO",
    role: "主对话状态机：单 alarm() 合并批处理，维护 update_steps 实时进度卡、agent_send 跨群通信与 QuickJS 编排。",
    tags: ["ModelAlarm", "update_steps", "agent_send"],
  },
  "do-requests": {
    name: "RequestsDO (CQRS)",
    role: "唯一管理台只读投影库：接收 150ms 触发器增量推送，汇总 TurnTiming/TTFT、1,000 条环形诊断日志与内部轨迹。",
    tags: ["TurnTiming / TTFT", "ops_logs 1000条", "view:sub 14d"],
  },
  "do-registry": {
    name: "RegistryDO",
    role: "集中管理模型账号、共享凭证（Cookie/Token 宿主代查）、有向通信边（256条覆盖）、Cua 设备分配与动态 MCP。",
    tags: ["共享凭证代查", "有向通信边", "Cua 设备分配"],
  },
  "do-sub": {
    name: "SubagentDO",
    role: "独立后台子任务执行体：冻结派出权限快照，支持按实例切模，通过 /work/agent-files/ 只读接收跨会话附件。",
    tags: ["独立模型切换", "Cua 交集复核", "agent-files 只读"],
  },
  "do-sched": {
    name: "ScheduleDO / EventsDO",
    role: "维护定时规则与外部事件订阅，后台触发前复验创建者 schedule 授权，失效自动暂停。",
    tags: ["授权复验", "Schedule", "Events"],
  },
  "do-sandbox": {
    name: "SandboxDO & WorkspaceDO",
    role: "编排 Cloudflare Containers (lite, uid 1000, 空闲 3m 休眠) 及 R2 SHA-256 去重快照、附件直写与分页 GC。",
    tags: ["uid 1000", "R2 去重快照", "agent-files 原子写"],
  },
  "ex-llm": {
    name: "LLM / Codex SSE",
    role: "由 ModelAlarm 通过 waitUntil() 消费完整流式响应，支持 Codex Zstd 还原 JSON SSE 与切模前上下文预压缩。",
    tags: ["ModelAlarm", "Zstd->JSON", "切前预压缩"],
  },
  "ex-r2": {
    name: "R2 & SQLite 存储",
    role: "私有 R2 存放 50 MiB/工作区去重快照、10 MiB 媒体与跨 Agent 附件；DO SQLite 触发器维护增量投影。",
    tags: ["50MiB 工作区", "7d/32MiB 请求体", "SQLite Triggers"],
  },
  "ex-cscoding": {
    name: "Sandbox cs.coding",
    role: "按需拉起的 Cloudflare Containers Linux 容器，支持群聊受控脚本、子任务克隆工作区与双版本 CAS 技能发布。",
    tags: ["@cloudflare/sandbox", "空闲 3m 休眠", "技能 CAS 发布"],
  },
  "ex-device": {
    name: "Cua 反向桥 (设备 & 持久 VM)",
    role: "自建 VPS 运行 Relay + cua daemon，经反向 WS 连回 Worker，统一管控 Mac/Linux 与持久 Windows VM。",
    tags: ["/mcp/reverse/cua", "按会话勾选设备", "截图自动转 imageId"],
  },
  "ex-runner": {
    name: "Windows runner/ (临时 WSB)",
    role: "Windows 宿主机 127.0.0.1:7791 专职提供临时 Windows Sandbox (wsb.exe) 的 6 个 env_* 工具，关闭即整机销毁。",
    tags: ["专职临时 WSB", "NTFS 硬链接", "独立 Guardian"],
  },
};

const seqMeta: Record<string, SeqMeta> = {
  all: {
    badge: "STEP ALL",
    text: "点击数字步骤 ①–⑥ 或“逐步演示”，观察请求如何在 5 条泳道间安全流转。",
    tags: ["Zero-Await Dispatch", "update_steps", "150ms Debounce"],
  },
  "1": {
    badge: "STEP 1",
    text: "/onebot 入站进入 BridgeDO：校验 QQ_OWNER 身份，附件经 get_file 直存工作区。",
    tags: ["QQ_OWNER", "BridgeDO"],
  },
  "2": {
    badge: "STEP 2",
    text: "BridgeDO 投递至 ThreadDO：单 alarm() 合并输入、模型出站、抽取与投影重试，防止重入。",
    tags: ["Single-Alarm", "Batch Merge"],
  },
  "3": {
    badge: "STEP 3",
    text: "ThreadDO 装配窗口（pi.compaction 预压缩）并每次 prepare 无缓存直读 SQLite 主线程规则。",
    tags: ["pi.compaction", "Direct DB Read"],
  },
  "4": {
    badge: "STEP 4",
    text: "ThreadDO.alarm() 第 1 行零前置 await 同步执行 modelAlarm.dispatch()，绕过 IoContext 截断。",
    tags: ["ModelAlarm", "Zero-Await"],
  },
  "5": {
    badge: "STEP 5",
    text: "QuickJS 编排多步工具、维护 update_steps 进度卡、agent_send 按有向边跨群通信，宿主代查凭证。",
    tags: ["QuickJS", "agent_send", "凭证代查"],
  },
  "6": {
    badge: "STEP 6",
    text: "出站消息经 BridgeDO 账本防双发；SQLite 触发器 150ms 防抖将步骤卡与 TurnTiming 投影至 RequestsDO。",
    tags: ["CQRS 150ms", "TurnTiming"],
  },
};

const compareData: Record<string, CompareEntry> = {
  webhook: {
    colLabel: "普通聊天 Webhook Bot",
    summary: "只在 HTTP 请求里同步转发模型和工具，连接超过平台限时就会中途断掉。",
    concession: "什么时候选它：只需要无状态一问一答、不涉及私有凭证和长耗时构建时，普通 Webhook 更省事。",
    rows: [
      ["长耗时派发", "直接在 HTTP RPC 内等待模型 SSE，响应时间一长就被网关或 IoContext 强杀。", "alarm() 首行零前置 await 同步派发 ModelAlarm，waitUntil() 完整消费长流式响应。"],
      ["多步编排", "每次工具调用都往返一轮模型推理，大段 JSON 返回直接撑爆上下文窗口。", "QuickJS Code Mode 单轮串联多步工具与沙盒调用，中间数据留在沙盒内部消化。"],
      ["凭证与权限", "环境变量和 Token 挂在同一个上下文里，群聊很容易顺手把敏感信息带出来。", "零信任 Proxy 强注 _meta.caller；共享凭证宿主代附头，群聊和子任务绝不触碰原文。"],
      ["实时看过程", "做完才回一条长消息，中途干到哪一步、卡在哪全靠猜。", "RequestsDO CQRS 150ms 增量投影，管理台直接看 update_steps 与 TurnTiming 而不打断执行。"],
      ["闪断与防重", "失败直接整体重试，极易在群里重复发两遍消息或重复写远端接口。", "四元组发送账本持久化追踪状态，断连进入 outcome_unknown 强制核对、严禁自动重放。"],
    ],
  },
  cli: {
    colLabel: "单机 CLI / 本地 Agent",
    summary: "绑在一台本机终端里跑，合上电脑盖子就断联，也没法在群里和团队事件联动。",
    concession: "什么时候选它：就在当前本地仓库旁边改两行代码、不需要定时触发与跨群通知时，本机 CLI 最趁手。",
    rows: [
      ["在线与入站", "依赖笔记本一直开机和终端挂着，手机或群里突然 @ 时往往连不上。", "Cloudflare Workers + 9 个 DO 7×24 云端常驻，QQ、Web、GitHub 与 Gmail 随时唤醒。"],
      ["算力隔离", "所有命令都在宿主机当前目录跑，跑陌生脚本很容易误伤本机环境。", "云端 Container、Cua 真机反向桥、一次性 Windows WSB 按风险级别自动分流。"],
      ["跨设备协同", "换一台虚拟机或办公 Mac 就要重新配一整套环境与历史上下文。", "云端保留长期记忆、规则和 R2 工作区快照；真机通过 443 反向 WS 即插即用。"],
      ["审批与风控", "命令往往顺手就跑下去了，缺少统一的资源绑定与高危变更审批记录。", "Cloudflare 资源创建与权限边调整走管理台 10m 一次性审批，拒绝则零写入。"],
      ["可观测性", "历史日志散落在各次终端滚动缓冲里，很难回溯哪轮工具耗时异常。", "RequestsDO 统一沉淀 1,000 条 ops_logs 与 TTFT 遥测，主人可直接自诊。"],
    ],
  },
  shared: {
    colLabel: "多群共用简单脚本",
    summary: "一个机器人号拉进所有群，谁都能调用同样记忆和机器，越权串台风险极高。",
    concession: "什么时候选它：只在完全可信的两三人内网小脚本里跑固定指令，不需要分会话授权时可以凑合用。",
    rows: [
      ["身份隔离", "群聊与私聊混用一套内存和提示词，群友的玩笑可能改写主人的行为规则。", "owner / group / private 命名空间硬隔离，宿主强校验 input 来源并拒信模型伪参。"],
      ["跨群文件", "靠复制粘贴或公网临时链接传文件，谁能看、能改没有清晰边界。", "agent_send 仅沿显式 Grant 的有向边通信，附件全文扫凭据后只读落盘 /work/agent-files/。"],
      ["规则生效", "改完配置经常要重启服务，或者等旧缓存过期才生效。", "主线程规则走双版本 CAS，每次 prepare 无缓存直读本地 SQLite 立即生效。"],
      ["真机分配", "一旦接入个人电脑，所有群都能看见并操作同一台桌面和文件系统。", "管理台按会话精确勾选授权哪台 Cua 设备，桥侧硬屏蔽危险宿主文件传输工具。"],
      ["冲突自愈", "群里出现互相矛盾的指令后静默覆盖旧记录，很难发现何时被改坏。", "证据记忆冲突自动入队，暂停画像自动复核等待主人拍板，并支持可恢复软遗忘。"],
    ],
  },
};

function renderTags(container: HTMLElement, tags: string[]) {
  const nodes = tags.map(t => {
    const span = document.createElement("span");
    span.className = "tag-mini";
    span.textContent = t;
    return span;
  });
  container.replaceChildren(...nodes);
}

const nav = $("top-nav");
const themeBtn = $<HTMLButtonElement>("theme-toggle");
const themeLabel = $("theme-label");

function syncScroll() {
  nav.classList.toggle("scrolled", window.scrollY > 8);
}

themeBtn.addEventListener("click", () => {
  const dark = !document.body.classList.contains("dark");
  document.body.classList.toggle("dark", dark);
  themeLabel.textContent = dark ? "LIGHT" : "DARK";
});

window.addEventListener("scroll", syncScroll, { passive: true });
syncScroll();

/* Interactive Colored Pixel-Matrix Joule Canvas */
const jouleCanvas = $<HTMLCanvasElement>("joule-canvas");

type PixelCell = {
  gx: number;
  gy: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  g: number;
  b: number;
  isCore: boolean;
  isCyan: boolean;
};

const LOGICAL_SIZE = 580;
const PIXEL_GRID = 76;

function buildPixelGrid(): PixelCell[] {
  const step = LOGICAL_SIZE / PIXEL_GRID;
  return JOULE_PIXELS.map(([gx, gy, r, g, b]) => ({
    gx,
    gy,
    x: gx * step,
    y: gy * step,
    vx: 0,
    vy: 0,
    r,
    g,
    b,
    isCore: r > 175 && g > 165 && b < 115,
    isCyan: b > r + 24 && g > r + 16,
  }));
}

function startPixelEngine(cells: PixelCell[]) {
  const ctx = jouleCanvas.getContext("2d");
  if (!ctx || cells.length === 0) return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  jouleCanvas.width = LOGICAL_SIZE * dpr;
  jouleCanvas.height = LOGICAL_SIZE * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const step = LOGICAL_SIZE / PIXEL_GRID;
  const block = Math.max(2, step - 1.0);
  let pointerX = -9999;
  let pointerY = -9999;
  let pointerActive = false;
  let pulseTime = -9999;
  let pulseX = LOGICAL_SIZE * 0.5;
  let pulseY = LOGICAL_SIZE * 0.5;

  const updatePointer = (e: PointerEvent) => {
    const rect = jouleCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    pointerX = ((e.clientX - rect.left) / rect.width) * LOGICAL_SIZE;
    pointerY = ((e.clientY - rect.top) / rect.height) * LOGICAL_SIZE;
    pointerActive = true;
  };

  jouleCanvas.addEventListener("pointermove", updatePointer);
  jouleCanvas.addEventListener("pointerenter", updatePointer);
  jouleCanvas.addEventListener("pointerleave", () => {
    pointerActive = false;
    pointerX = -9999;
    pointerY = -9999;
  });
  jouleCanvas.addEventListener("pointerdown", e => {
    updatePointer(e);
    pulseTime = performance.now();
    pulseX = pointerX;
    pulseY = pointerY;
  });

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const frame = (now: number) => {
    const isDark = document.body.classList.contains("dark");
    const accentColor = isDark ? "#6fe0a0" : "#0d7148";
    const t = reducedMotion ? 0 : now;
    const sweep = ((t * 0.048) % (PIXEL_GRID * 2 + 40)) - 20;
    const pulseElapsed = now - pulseTime;
    const pulseRadius = pulseElapsed >= 0 && pulseElapsed < 800 ? pulseElapsed * 0.68 : -1;

    ctx.clearRect(0, 0, LOGICAL_SIZE, LOGICAL_SIZE);

    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]!;
      const sway = reducedMotion ? 0 : Math.sin(t * 0.0024 + c.gx * 0.1 + c.gy * 0.06) * 1.1;
      const homeX = c.gx * step;
      const homeY = c.gy * step + sway;

      let fx = 0;
      let fy = 0;
      let hoverFactor = 0;
      if (pointerActive) {
        const cx = c.x + block * 0.5;
        const cy = c.y + block * 0.5;
        const dx = cx - pointerX;
        const dy = cy - pointerY;
        const dist = Math.hypot(dx, dy);
        if (dist < 88 && dist > 0.01) {
          const force = (1 - dist / 88) * 4.8;
          fx += (dx / dist) * force - (dy / dist) * force * 0.35;
          fy += (dy / dist) * force + (dx / dist) * force * 0.35;
          hoverFactor = 1 - dist / 88;
        }
      }

      let shockFactor = 0;
      if (pulseRadius > 0) {
        const cx = c.x + block * 0.5;
        const cy = c.y + block * 0.5;
        const sdx = cx - pulseX;
        const sdy = cy - pulseY;
        const sdist = Math.hypot(sdx, sdy);
        const band = Math.abs(sdist - pulseRadius);
        if (band < 38 && sdist > 0.01) {
          const wave = (1 - band / 38) * (1 - pulseElapsed / 800);
          fx += (sdx / sdist) * wave * 8.8;
          fy += (sdy / sdist) * wave * 8.8;
          shockFactor = wave;
        }
      }

      c.vx = (c.vx + (homeX - c.x) * 0.14 + fx) * 0.74;
      c.vy = (c.vy + (homeY - c.y) * 0.14 + fy) * 0.74;
      c.x += c.vx;
      c.y += c.vy;

      let rr = c.r;
      let gg = c.g;
      let bb = c.b;

      if (c.isCore) {
        const glow = Math.round((Math.sin(t * 0.005) * 0.5 + 0.5) * 34);
        rr = Math.min(255, rr + glow);
        gg = Math.min(255, gg + glow);
      } else if (c.isCyan) {
        const glint = Math.max(0, 1 - Math.abs(c.gx + c.gy - sweep) / 8);
        if (glint > 0.1) {
          const lift = Math.round(glint * 46);
          gg = Math.min(255, gg + lift);
          bb = Math.min(255, bb + lift);
        }
      }

      const boost = Math.max(hoverFactor * 75, shockFactor * 110);
      if (boost > 1) {
        rr = Math.min(255, Math.round(rr + boost));
        gg = Math.min(255, Math.round(gg + boost));
        bb = Math.min(255, Math.round(bb + boost));
      }

      ctx.fillStyle = `rgb(${rr},${gg},${bb})`;
      ctx.fillRect(c.x, c.y, block, block);
    }

    if (pointerActive) {
      ctx.save();
      ctx.strokeStyle = accentColor;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(pointerX, pointerY, 46, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(pointerX - 7, pointerY);
      ctx.lineTo(pointerX + 7, pointerY);
      ctx.moveTo(pointerX, pointerY - 7);
      ctx.lineTo(pointerX, pointerY + 7);
      ctx.stroke();
      ctx.restore();
    }

    window.requestAnimationFrame(frame);
  };
  window.requestAnimationFrame(frame);
}

const initJoule = () => {
  const cells = buildPixelGrid();
  if (cells.length > 0) startPixelEngine(cells);
};
initJoule();

/* Scroll Reveal for Chapters */
const chapters = Array.from(document.querySelectorAll<HTMLElement>("main section.chap"));
if ("IntersectionObserver" in window) {
  for (const s of chapters) s.classList.add("reveal");
  const io = new IntersectionObserver(
    entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          io.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.08 },
  );
  for (const s of chapters) io.observe(s);
}

/* Chapter 1: 5-Step Live Workflow Spotlight */
const wfStepper = $("wf-stepper");
const wfSteps = Array.from(wfStepper.querySelectorAll<HTMLButtonElement>(".wf-step"));
const spotBoxes = Array.from(document.querySelectorAll<HTMLElement>("[data-spot]"));
let wfTimer: number | undefined;
let wfCurrent = 1;

function selectWorkflowStep(stepNum: number) {
  wfCurrent = stepNum;
  const key = String(stepNum);
  for (const btn of wfSteps) {
    const active = btn.dataset.wf === key;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  }
  for (const box of spotBoxes) {
    const hit = box.dataset.spot === key;
    box.classList.toggle("spotlight", hit);
    box.classList.toggle("dimmed", !hit);
  }
}

for (const btn of wfSteps) {
  btn.addEventListener("click", () => {
    if (wfTimer !== undefined) {
      window.clearInterval(wfTimer);
      wfTimer = undefined;
    }
    wfStepper.classList.add("paused");
    selectWorkflowStep(Number(btn.dataset.wf || "1"));
  });
}

if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  wfTimer = window.setInterval(() => {
    wfCurrent = wfCurrent >= 5 ? 1 : wfCurrent + 1;
    selectWorkflowStep(wfCurrent);
  }, 4800);
}
selectWorkflowStep(1);

/* Chapter 2: Memory & Rules Filter */
const memFilterBtns = Array.from(document.querySelectorAll<HTMLButtonElement>("#mem-filters .t-btn"));
const memRows = Array.from(document.querySelectorAll<HTMLElement>("#mem-list .mem-row"));

for (const btn of memFilterBtns) {
  btn.addEventListener("click", () => {
    const kind = btn.dataset.kind ?? "all";
    for (const b of memFilterBtns) b.classList.toggle("active", b === btn);
    for (const row of memRows) {
      row.hidden = kind !== "all" && row.dataset.kind !== kind;
    }
  });
}

/* Chapter 3: Compute & Devices Filter */
const machFilterBtns = Array.from(document.querySelectorAll<HTMLButtonElement>("#mach-filters .t-btn"));
const machRows = Array.from(document.querySelectorAll<HTMLElement>("#mach-list .mach-row"));

for (const btn of machFilterBtns) {
  btn.addEventListener("click", () => {
    const mach = btn.dataset.mach ?? "all";
    for (const b of machFilterBtns) b.classList.toggle("active", b === btn);
    for (const row of machRows) {
      const tags = (row.dataset.mach ?? "all").split(/\s+/);
      row.classList.toggle("dimmed", !tags.includes(mach));
    }
  });
}

/* Chapter 4: Interactive Topology Inspector */
const inspName = $("insp-name");
const inspRole = $("insp-role");
const inspTags = $("insp-tags");
const archNodes = Array.from(document.querySelectorAll<SVGGElement>("#arch-svg .svg-node"));
const archEdges = Array.from(document.querySelectorAll<SVGElement>("#arch-svg .svg-edge"));
const routeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("#route-filters .t-btn"));

function showNode(id?: string) {
  if (!id) return;
  const info = nodeMeta[id];
  if (!info) return;
  for (const n of archNodes) n.classList.toggle("selected", n.dataset.node === id);
  inspName.textContent = info.name;
  inspRole.textContent = info.role;
  renderTags(inspTags, info.tags);
}

for (const n of archNodes) {
  n.addEventListener("click", () => showNode(n.dataset.node));
  n.addEventListener("mouseenter", () => showNode(n.dataset.node));
  n.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      showNode(n.dataset.node);
    }
  });
}

for (const btn of routeButtons) {
  btn.addEventListener("click", () => {
    const route = btn.dataset.route ?? "all";
    for (const b of routeButtons) b.classList.toggle("active", b === btn);
    for (const n of archNodes) {
      const list = (n.dataset.routes ?? "").split(/\s+/);
      n.classList.toggle("dimmed", !list.includes(route));
    }
    for (const e of archEdges) {
      const list = (e.dataset.routes ?? "").split(/\s+/);
      e.classList.toggle("dimmed", !list.includes(route));
    }
  });
}

/* Chapter 4: Interactive Sequence Lifecycle Player */
const seqSteps = Array.from(document.querySelectorAll<SVGGElement>("#seq-svg .seq-step"));
const seqPills = Array.from(document.querySelectorAll<HTMLButtonElement>("#seq-pills .t-btn"));
const seqBadge = $("seq-badge");
const seqCaption = $("seq-caption");
const seqTags = $("seq-tags");
const playBtn = $<HTMLButtonElement>("seq-play");
const resetBtn = $<HTMLButtonElement>("seq-reset");
let seqTimer: number | undefined;

function setStep(step: string) {
  for (const p of seqPills) p.classList.toggle("active", p.dataset.step === step);
  for (const g of seqSteps) {
    const active = step === "all" || g.dataset.step === step;
    g.classList.toggle("dimmed", !active);
    g.classList.toggle("active", step !== "all" && g.dataset.step === step);
  }
  const m = seqMeta[step] ?? seqMeta.all!;
  seqBadge.textContent = m.badge;
  seqCaption.textContent = m.text;
  renderTags(seqTags, m.tags);
}

function stopPlay() {
  if (seqTimer !== undefined) {
    window.clearInterval(seqTimer);
    seqTimer = undefined;
  }
  playBtn.textContent = "▶ 逐步演示";
}

for (const p of seqPills) {
  p.addEventListener("click", () => {
    stopPlay();
    setStep(p.dataset.step ?? "all");
  });
}

for (const g of seqSteps) {
  g.addEventListener("click", () => {
    stopPlay();
    setStep(g.dataset.step ?? "all");
  });
}

resetBtn.addEventListener("click", () => {
  stopPlay();
  setStep("all");
});

playBtn.addEventListener("click", () => {
  if (seqTimer !== undefined) {
    stopPlay();
    return;
  }
  let cur = 1;
  playBtn.textContent = "⏸ 暂停";
  setStep(String(cur));
  seqTimer = window.setInterval(() => {
    cur += 1;
    if (cur > 6) {
      stopPlay();
      setStep("all");
      return;
    }
    setStep(String(cur));
  }, 1600);
});

/* Chapter 5: Interactive Comparison Table */
const cmpTabs = Array.from(document.querySelectorAll<HTMLButtonElement>("#cmp-tabs .t-btn"));
const cmpSummary = $("cmp-summary");
const cmpColOther = $("cmp-col-other");
const cmpRows = $("cmp-rows");
const cmpConcession = $("cmp-concession");

function renderCompare(key: string) {
  const entry = compareData[key] ?? compareData.webhook!;
  for (const b of cmpTabs) b.classList.toggle("active", b.dataset.cmp === key);
  cmpColOther.textContent = entry.colLabel;
  cmpSummary.textContent = entry.summary;
  cmpConcession.textContent = entry.concession;

  const rowNodes = entry.rows.map(([dim, other, ours]) => {
    const row = document.createElement("div");
    row.className = "cmp-tr";

    const d = document.createElement("div");
    d.className = "cmp-dim";
    d.textContent = dim;

    const o = document.createElement("div");
    o.className = "cmp-bad";
    o.textContent = other;

    const u = document.createElement("div");
    u.className = "cmp-good";
    u.textContent = ours;

    row.replaceChildren(d, o, u);
    return row;
  });
  cmpRows.replaceChildren(...rowNodes);
}

for (const b of cmpTabs) {
  b.addEventListener("click", () => renderCompare(b.dataset.cmp ?? "webhook"));
}
renderCompare("webhook");

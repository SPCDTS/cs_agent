/**
 * 面板设计系统（设计 §8.4）。方向："调度单"——每条 QQ 消息是一张在分拣台上流转的单据：
 * 冷灰蓝的纸面、靛青墨水正文、复写纸蓝作为唯一强调色；状态用"印章"（描边双字戳）表达，
 * 详情页是一条竖向流转轨迹。无外部字体/CDN；深浅色由 prefers-color-scheme 自动切换。
 */
export const THEME_CSS = String.raw`
:root{
  color-scheme:light dark;
  --paper:#e8ecf1; --sheet:#fbfcfd; --sheet-2:#f2f5f8; --ink:#17223a; --ink-2:#4d596e; --ink-3:#6f7a8e;
  --rule:#cdd4de; --rule-strong:#a9b3c2;
  --carbon:#2b47b5; --carbon-soft:#dfe5fa;
  --ok:#1d7549; --ok-soft:#dcefe4; --fail:#b42f27; --fail-soft:#f7e0dd; --warn:#9c620f; --warn-soft:#f5ead7;
  --queued:#5d4fa6; --queued-soft:#e7e3f6;
  --font:"PingFang SC","Hiragino Sans GB","Microsoft YaHei UI","Microsoft YaHei","Noto Sans CJK SC","Source Han Sans SC",system-ui,-apple-system,"Segoe UI",sans-serif;
  --mono:"Cascadia Mono","SF Mono",Menlo,Consolas,"Noto Sans Mono CJK SC",monospace;
  --t-xs:12.5px; --t-sm:13.5px; --t-md:15px; --t-lg:18px; --t-xl:23px; --t-2xl:30px;
  --s1:4px; --s2:8px; --s3:12px; --s4:16px; --s5:24px; --s6:32px; --s7:48px;
  --r-sm:3px; --r-md:6px; --r-lg:10px;
  --shadow:0 1px 0 rgba(23,34,58,.06),0 6px 18px -10px rgba(23,34,58,.25);
  --measure:68ch;
}
@media (prefers-color-scheme:dark){:root{
  --paper:#0e131b; --sheet:#151c27; --sheet-2:#1b2431; --ink:#e3e8f0; --ink-2:#a3aec0; --ink-3:#7f8a9d;
  --rule:#283244; --rule-strong:#3a4659;
  --carbon:#8ea3ff; --carbon-soft:#1f2948;
  --ok:#5cc48d; --ok-soft:#14301f; --fail:#f2786e; --fail-soft:#3a1916; --warn:#e2a94b; --warn-soft:#352610;
  --queued:#b4a7f3; --queued-soft:#29234a;
  --shadow:0 1px 0 rgba(0,0,0,.4),0 8px 22px -12px rgba(0,0,0,.7);
}}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:400 var(--t-md)/1.65 var(--font);font-feature-settings:"tnum" 1;}
a{color:var(--carbon);text-decoration-thickness:1px;text-underline-offset:3px}
a:hover{text-decoration-thickness:2px}
:focus-visible{outline:2px solid var(--carbon);outline-offset:2px;border-radius:2px}
h1,h2,h3{font-weight:600;line-height:1.3;margin:0}
h1{font-size:var(--t-xl);letter-spacing:.01em}
h2{font-size:var(--t-lg)}
h3{font-size:var(--t-md)}
p{margin:0 0 var(--s3)}
small,.muted{color:var(--ink-2)}
.faint{color:var(--ink-3)}
code,.mono,pre{font-family:var(--mono);font-size:var(--t-sm)}
pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--sheet-2);border:1px solid var(--rule);border-radius:var(--r-md);padding:var(--s3) var(--s4);max-height:520px;overflow:auto}

/* ── 页头与导航 ── */
.top{background:var(--sheet);border-bottom:1px solid var(--rule)}
.top-in{max-width:1180px;margin:0 auto;padding:0 var(--s5);display:flex;align-items:stretch;gap:var(--s5)}
.mark{display:flex;align-items:center;gap:var(--s2);font-weight:700;font-size:var(--t-md);color:var(--ink);text-decoration:none;white-space:nowrap;padding:var(--s3) 0}
.mark i{display:inline-block;width:14px;height:18px;border:2px solid var(--carbon);border-radius:2px;position:relative}
.mark i::after{content:"";position:absolute;left:2px;right:2px;top:5px;border-top:2px solid var(--carbon);box-shadow:0 4px 0 var(--carbon)}
.mark span{font-weight:400;color:var(--ink-2)}
nav.tabs{display:flex;gap:var(--s1);overflow-x:auto;scrollbar-width:none;margin-left:auto}
nav.tabs::-webkit-scrollbar{display:none}
nav.tabs a{display:flex;align-items:center;padding:0 var(--s3);color:var(--ink-2);text-decoration:none;white-space:nowrap;border-bottom:2px solid transparent;font-size:var(--t-sm)}
nav.tabs a:hover{color:var(--ink)}
nav.tabs a[aria-current=page]{color:var(--ink);border-bottom-color:var(--carbon);font-weight:600}
nav.tabs .live-dot{width:7px;height:7px;border-radius:50%;background:var(--carbon);margin-right:6px}
main{max-width:1180px;margin:0 auto;padding:var(--s6) var(--s5) var(--s7);overflow-wrap:anywhere}
.head>div:first-child{min-width:0;flex:1 1 320px}
.grid>*,.slips>*,.scope-group{min-width:0}
.head{display:flex;flex-wrap:wrap;align-items:flex-end;gap:var(--s3) var(--s5);margin-bottom:var(--s5)}
.head p{margin:var(--s1) 0 0;color:var(--ink-2);max-width:var(--measure)}
.head .actions{margin-left:auto;display:flex;gap:var(--s2);flex-wrap:wrap}
section{margin-top:var(--s6)}
section>h2{margin-bottom:var(--s3);display:flex;align-items:baseline;gap:var(--s3)}
section>h2 small{font-size:var(--t-sm);font-weight:400}
section.flush{margin-top:0}
.mt{margin-top:var(--s3)}
.sheet>section{margin-top:0}
dl.kv.meta{grid-template-columns:repeat(3,max-content minmax(0,1fr))}
@media (max-width:900px){dl.kv.meta{grid-template-columns:max-content minmax(0,1fr)}}

/* ── 印章（状态） ── */
.stamp{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border:1.5px solid currentColor;border-radius:var(--r-sm);font-size:var(--t-xs);font-weight:700;letter-spacing:.12em;line-height:1.5;white-space:nowrap;background:transparent}
.stamp.big{font-size:var(--t-md);padding:3px 12px;border-width:2px;box-shadow:inset 0 0 0 2px var(--sheet),inset 0 0 0 3.5px currentColor;transform:rotate(-2deg)}
.s-ok{color:var(--ok)} .s-fail{color:var(--fail)} .s-warn{color:var(--warn)} .s-run{color:var(--carbon)} .s-queue{color:var(--queued)} .s-idle{color:var(--ink-3)}
.pill{display:inline-block;padding:0 7px;border-radius:999px;background:var(--sheet-2);border:1px solid var(--rule);font-size:var(--t-xs);color:var(--ink-2);white-space:nowrap}

/* ── 面板与表格 ── */
.sheet{background:var(--sheet);border:1px solid var(--rule);border-radius:var(--r-lg);box-shadow:var(--shadow)}
.sheet.pad{padding:var(--s4) var(--s5)}
.grid{display:grid;gap:var(--s4)}
.cols-2{grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
.cols-3{grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
table.list{width:100%;border-collapse:collapse;font-size:var(--t-sm)}
.list th{text-align:left;font-weight:600;color:var(--ink-2);padding:var(--s2) var(--s3);border-bottom:1px solid var(--rule-strong);white-space:nowrap}
.list td{padding:var(--s2) var(--s3);border-bottom:1px solid var(--rule);vertical-align:top;overflow-wrap:anywhere}
.list tr:last-child td{border-bottom:0}
.list tbody tr:hover td{background:var(--sheet-2)}
.list .num{text-align:right;white-space:nowrap}
.wrap{overflow-x:auto}
dl.kv{display:grid;grid-template-columns:max-content 1fr;gap:var(--s2) var(--s4);margin:0;font-size:var(--t-sm)}
dl.kv dt{color:var(--ink-2)} dl.kv dd{margin:0;overflow-wrap:anywhere}
.figure{font-size:var(--t-2xl);font-weight:600;line-height:1.1}
.figure small{font-size:var(--t-md);font-weight:400}
.excerpt{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.empty{padding:var(--s5);text-align:left;color:var(--ink-2);border:1px dashed var(--rule-strong);border-radius:var(--r-lg);background:transparent}
.flash{padding:var(--s3) var(--s4);border-radius:var(--r-md);border:1px solid var(--ok);background:var(--ok-soft);color:var(--ink);margin-bottom:var(--s4)}
.flash.err{border-color:var(--fail);background:var(--fail-soft)}

/* ── 信号灯（健康） ── */
.lamps{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:0;border:1px solid var(--rule);border-radius:var(--r-lg);background:var(--sheet);overflow:hidden}
.lamp{padding:var(--s3) var(--s4);border-right:1px solid var(--rule);border-bottom:1px solid var(--rule);margin:-0 -1px -1px 0}
.lamp b{display:flex;align-items:center;gap:var(--s2);font-weight:600;font-size:var(--t-sm)}
.lamp small{display:block;font-size:var(--t-xs);margin-top:2px}
.dot{width:9px;height:9px;border-radius:50%;flex:none;background:var(--ink-3)}
.dot.ok{background:var(--ok)} .dot.fail{background:var(--fail)} .dot.warn{background:var(--warn)} .dot.run{background:var(--carbon)}

/* ── 表单 ── */
form.bar{display:flex;flex-wrap:wrap;gap:var(--s2) var(--s3);align-items:flex-end;margin-bottom:var(--s4)}
label{display:flex;flex-direction:column;gap:var(--s1);font-size:var(--t-sm);color:var(--ink-2)}
label>select{align-self:flex-start;min-width:160px}
input,select,textarea{font:inherit;font-size:var(--t-sm);color:var(--ink);background:var(--sheet);border:1px solid var(--rule-strong);border-radius:var(--r-md);padding:7px 10px;min-width:0;max-width:100%}
textarea{width:100%;font-family:var(--mono);line-height:1.55;resize:vertical}
button,.btn{font:inherit;font-size:var(--t-sm);font-weight:600;border-radius:var(--r-md);padding:7px 14px;border:1px solid var(--carbon);background:var(--carbon);color:var(--sheet);cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px}
button.quiet,.btn.quiet{background:transparent;color:var(--carbon)}
button.danger{background:transparent;border-color:var(--fail);color:var(--fail)}
button:hover{filter:brightness(1.08)}
fieldset{border:0;padding:0;margin:0 0 var(--s5)}
legend{font-weight:600;font-size:var(--t-md);margin-bottom:var(--s2);padding:0}
.choices{display:flex;flex-wrap:wrap;gap:var(--s2)}
.choice{flex-direction:row;align-items:flex-start;gap:var(--s2);padding:var(--s3) var(--s4);border:1px solid var(--rule-strong);border-radius:var(--r-md);background:var(--sheet);color:var(--ink);cursor:pointer;min-width:200px;flex:1}
.choice:has(input:checked){border-color:var(--carbon);box-shadow:inset 0 0 0 1px var(--carbon);background:var(--carbon-soft)}
.choice input{margin-top:5px}
.choice span small{display:block}
.hint{font-size:var(--t-xs);color:var(--ink-3);margin-top:var(--s1)}
.changed{color:var(--warn);font-size:var(--t-xs);font-weight:600}

/* ── 流转轨迹（票据详情） ── */
ol.trail{list-style:none;margin:0;padding:0 0 0 var(--s5);position:relative}
ol.trail::before{content:"";position:absolute;left:7px;top:6px;bottom:6px;border-left:2px solid var(--rule-strong)}
.trail li{position:relative;padding:0 0 var(--s4) var(--s3)}
.trail li::before{content:"";position:absolute;left:calc(-1 * var(--s5) + 2px);top:7px;width:12px;height:12px;border-radius:50%;background:var(--sheet);border:2px solid var(--ink-3)}
.trail li.ok::before{border-color:var(--ok);background:var(--ok)}
.trail li.failed::before{border-color:var(--fail);background:var(--fail)}
.trail li.started::before{border-color:var(--carbon)}
.trail li.terminal::before{width:16px;height:16px;left:calc(-1 * var(--s5));top:5px}
.trail .row{display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--s1) var(--s3)}
.trail .stage{font-weight:600}
.trail li.started .stage{font-weight:400;color:var(--ink-2)}
.trail .t{font-size:var(--t-xs);color:var(--ink-3);min-width:62px}
.trail .sum{font-size:var(--t-sm);color:var(--ink-2);margin-top:2px;overflow-wrap:anywhere}
.trail details{margin-top:var(--s1)}
summary{cursor:pointer;color:var(--ink-2);font-size:var(--t-xs)}
blockquote.said{margin:0;padding:var(--s4) var(--s5);background:var(--sheet);border:1px solid var(--rule);border-left:4px solid var(--carbon);border-radius:var(--r-md);font-size:var(--t-lg);line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;max-width:var(--measure)}
.thumbs{display:flex;flex-wrap:wrap;gap:var(--s3)}
.thumbs img{width:180px;height:180px;object-fit:cover;border-radius:var(--r-md);border:1px solid var(--rule);background:var(--sheet-2)}

/* ── 实时单据 ── */
.scope-group{margin-top:var(--s5)}
.scope-group>h3{display:flex;align-items:center;gap:var(--s2);margin-bottom:var(--s2);font-size:var(--t-sm);color:var(--ink-2);font-weight:600}
.slips{display:grid;gap:var(--s3);grid-template-columns:minmax(0,1fr)}
.slip{background:var(--sheet);border:1px solid var(--rule);border-radius:var(--r-md);box-shadow:var(--shadow);display:grid;grid-template-columns:5px minmax(0,1fr);overflow:hidden}
.slip::before{content:"";background:repeating-linear-gradient(to bottom,var(--carbon) 0 6px,transparent 6px 10px)}
.slip.queued::before{background:repeating-linear-gradient(to bottom,var(--queued) 0 6px,transparent 6px 10px)}
.slip-body{padding:var(--s3) var(--s4);min-width:0}
.slip-top{display:flex;flex-wrap:wrap;align-items:center;gap:var(--s2) var(--s3)}
.slip-top .who{font-size:var(--t-sm);color:var(--ink-2)}
.slip-top .elapsed{margin-left:auto;font-size:var(--t-sm);color:var(--ink-2)}
.slip .text{margin:var(--s2) 0;font-size:var(--t-md);overflow-wrap:anywhere}
.phase{display:flex;align-items:center;gap:var(--s2);font-size:var(--t-sm)}
.phase .pulse{width:8px;height:8px;border-radius:50%;background:var(--carbon);animation:pulse 1.6s ease-in-out infinite}
@keyframes pulse{50%{opacity:.25}}
ol.feed{list-style:none;margin:var(--s3) 0 0;padding:var(--s2) 0 0;border-top:1px dashed var(--rule-strong);font-size:var(--t-xs);max-height:240px;overflow:auto}
.feed li{display:grid;grid-template-columns:6em minmax(0,1fr);gap:var(--s2);padding:2px 0;color:var(--ink-2)}
.feed li>.faint{white-space:nowrap;font-variant-numeric:tabular-nums}
.feed li b{font-weight:600;color:var(--ink)}
.feed li.failed b{color:var(--fail)}
.feed li.started b{font-weight:400;color:var(--carbon)}
.feed li .sum{overflow-wrap:anywhere}
.done-list{display:grid;gap:var(--s1);grid-template-columns:minmax(0,1fr)}
.done-list details{background:var(--sheet);border:1px solid var(--rule);border-radius:var(--r-md);padding:var(--s2) var(--s3)}
.done-list summary{display:flex;gap:var(--s3);align-items:center;font-size:var(--t-sm);color:var(--ink);list-style:none}
.done-list summary::-webkit-details-marker{display:none}
.done-list .excerpt{flex:1;min-width:0;-webkit-line-clamp:1}
.flashin{animation:flashin 1.2s ease-out}
@keyframes flashin{from{background:var(--carbon-soft)}}
.conn{font-size:var(--t-xs);color:var(--ink-3)}
.conn.on::before{content:"● ";color:var(--ok)}
.conn.off::before{content:"● ";color:var(--fail)}

/* ── 上下文占用条（设计 §8.5）：轨道是一把刻度尺，每 10% 一道细刻线；墨色按占比由复写纸蓝转为琥珀、朱红。
   pi 的两道压缩阈值是贯穿轨道的刻口（悬停看说明）；估算值用斜线虚填，超过 24 小时未更新的整体褪色。 ── */
.ctx-list{display:grid;gap:var(--s4) var(--s6);grid-template-columns:repeat(auto-fit,minmax(min(100%,380px),1fr))}
.ctx{--ctx-ink:var(--carbon);min-width:0}
.ctx-t-warn{--ctx-ink:var(--warn)} .ctx-t-hot{--ctx-ink:var(--fail)}
.ctx-stale,.ctx-none{--ctx-ink:var(--ink-3)}
.ctx-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 var(--s3);margin-bottom:6px}
.ctx-label{font-weight:600;font-size:var(--t-sm)}
.ctx-num{font-size:var(--t-sm);color:var(--ink-2);white-space:nowrap;font-variant-numeric:tabular-nums}
.ctx-num b{font-weight:600;color:var(--ink)}
.ctx-short{font-size:var(--t-xs);color:var(--ink-3);white-space:nowrap}
.ctx-pct{margin-left:auto;font-weight:700;font-size:var(--t-md);color:var(--ctx-ink);white-space:nowrap;font-variant-numeric:tabular-nums}
.ctx-track{position:relative;display:block;height:10px;border:1px solid var(--rule-strong);border-radius:var(--r-sm);background:var(--sheet-2)}
.ctx-track::after{content:"";position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(to right,transparent 0 calc(10% - 1px),var(--rule) calc(10% - 1px) 10%)}
.ctx-fill{position:absolute;left:0;top:0;bottom:0;width:0;background:var(--ctx-ink);border-radius:2px 0 0 2px}
.ctx-fill[data-w="100"]{border-radius:2px}
.ctx-est .ctx-fill{background:repeating-linear-gradient(135deg,var(--ctx-ink) 0 3px,transparent 3px 6px);outline:1px dashed var(--ctx-ink);outline-offset:-1px}
.ctx-stale .ctx-fill{opacity:.55}
.ctx-stale .ctx-label,.ctx-stale .ctx-num b{color:var(--ink-2)}
.ctx-tick{position:absolute;top:-5px;bottom:-5px;width:11px;margin-left:-5px;z-index:1;cursor:help}
.ctx-tick::before{content:"";position:absolute;left:4px;top:0;bottom:0;width:3px;background:var(--sheet);border-left:1px solid var(--ink-2);border-right:1px solid var(--ink-2)}
.ctx-tick.ctx-rs::before{border-color:var(--fail)}
.ctx-tick:hover::before{background:var(--ink-2)} .ctx-tick.ctx-rs:hover::before{background:var(--fail)}
.ctx-meta{margin-top:6px;font-size:var(--t-xs);color:var(--ink-3)}
.ctx-none .ctx-pct{color:var(--ink-3)}
.ctx-mini{display:flex;align-items:center;gap:var(--s2);flex:1 1 180px;max-width:300px;font-size:var(--t-xs);cursor:default}
.ctx-mini .ctx-track{flex:1 1 60px;min-width:48px;height:6px}
.ctx-mini .ctx-tick{top:-3px;bottom:-3px}
.ctx-mini .ctx-pct{margin-left:0;font-size:var(--t-xs)}
.ctx-mini .ctx-short{color:var(--ink-3)}
.slip-top .ctx-mini{order:9}
.thread-ctx{margin-bottom:var(--s4);padding-bottom:var(--s4);border-bottom:1px dashed var(--rule-strong)}
${Array.from({ length: 101 }, (_, i) => `.ctx-fill[data-w="${i}"]{width:${i}%}.ctx-tick[data-at="${i}"]{left:${i}%}`).join('\n')}

/* ── 日志 ── */
.log{font-family:var(--mono);font-size:var(--t-xs);background:var(--sheet);border:1px solid var(--rule);border-radius:var(--r-md);max-height:70vh;overflow:auto;padding:var(--s2) 0}
.log div{padding:1px var(--s4);white-space:pre-wrap;overflow-wrap:anywhere;border-left:3px solid transparent}
.log .warn{border-left-color:var(--warn)} .log .error{border-left-color:var(--fail);background:var(--fail-soft)} .log .debug{color:var(--ink-3)}

/* ── Agent → 会话 → 回合（观测 v2） ── */
.crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:var(--s1) var(--s2);font-size:var(--t-sm);margin-bottom:var(--s4);color:var(--ink-2)}
.crumbs .sep{color:var(--ink-3)}
.crumbs [aria-current]{color:var(--ink);font-weight:600}
.agent-card h2{margin-bottom:var(--s3);display:flex;align-items:baseline;gap:var(--s3)}
.agent-card h2 a{color:var(--ink);text-decoration:none}
.agent-card h2 small{font-size:var(--t-sm);font-weight:400}
.agent-figs{display:flex;gap:var(--s6);margin-bottom:var(--s3)}
.thread-list{display:grid;gap:var(--s4);padding-top:var(--s3);border-top:1px dashed var(--rule-strong)}
.thread-row{display:flex;align-items:flex-end;gap:var(--s3)}
.thread-row>.ctx{flex:1 1 auto}
.thread-row form{flex:none}
.thread-row button{padding:4px 10px;font-size:var(--t-xs)}
.idbox{display:inline-flex;align-items:center;gap:var(--s2);max-width:100%}
.idbox code{overflow-wrap:anywhere;user-select:all}
button.copy,button.load-full{padding:2px 9px;font-size:var(--t-xs);font-weight:500}
.sess-head .ctx{max-width:640px}
.turns-layout{display:grid;grid-template-columns:minmax(220px,300px) minmax(0,1fr);gap:var(--s4);margin-top:var(--s5);align-items:start}
.tdir{padding:var(--s3) 0;position:sticky;top:var(--s3);max-height:calc(100vh - 2 * var(--s3));overflow:auto}
.tdir h2{font-size:var(--t-sm);padding:0 var(--s4) var(--s2);color:var(--ink-2)}
.tdir h2 small{font-weight:400}
.tdir ol{list-style:none;margin:0;padding:0}
.tdir li{padding:var(--s2) var(--s4);border-top:1px solid var(--rule)}
.tdir li a{color:var(--ink);text-decoration:none;font-size:var(--t-sm)}
.tdir li a:hover .excerpt{text-decoration:underline}
.dir-meta{display:flex;flex-wrap:wrap;gap:2px var(--s2);align-items:center;font-size:var(--t-xs);margin-top:2px}
.tstream{display:grid;gap:var(--s3);grid-template-columns:minmax(0,1fr)}
details.turn{padding:0;overflow:hidden}
.turn-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--s1) var(--s3);padding:var(--s3) var(--s4);list-style:none;color:var(--ink);font-size:var(--t-sm)}
.turn-head::-webkit-details-marker{display:none}
.turn-head::before{content:"▸";color:var(--ink-3);font-size:var(--t-xs)}
details.turn[open]>.turn-head::before{content:"▾"}
details.turn[open]>.turn-head{border-bottom:1px solid var(--rule);background:var(--sheet-2)}
.th-preview{flex:1 1 260px;min-width:0;font-weight:600;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.tm{display:flex;flex-wrap:wrap;gap:2px var(--s3);font-size:var(--t-xs);color:var(--ink-2);width:100%}
.tm>span:empty{display:none}
.tm-ctx{color:var(--carbon);font-weight:600}
.tm-sum{color:var(--ink-3)}
.tm-links{display:inline-flex;flex-wrap:wrap;gap:var(--s3)}
.turn-bar{display:flex;flex-wrap:wrap;gap:var(--s3);padding:var(--s2) var(--s4);font-size:var(--t-xs);border-bottom:1px dashed var(--rule)}
.turn-body{padding:var(--s3) var(--s4);display:grid;gap:var(--s2);grid-template-columns:minmax(0,1fr)}
.turn-body.full{padding:0}
.blk{min-width:0;font-size:var(--t-sm)}
.blk .bk{font-size:var(--t-xs);font-weight:700;letter-spacing:.08em;color:var(--ink-3);margin-bottom:2px}
.bt.prose{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6}
.bt.partial{border-left:2px dashed var(--rule-strong);padding-left:var(--s2)}
.blk.user{background:var(--carbon-soft);border-radius:var(--r-md);padding:var(--s2) var(--s3);border-left:3px solid var(--carbon)}
.blk.assistant{padding:var(--s2) var(--s3);border-left:3px solid var(--ok)}
.blk.image{display:flex;flex-wrap:wrap;gap:var(--s2);align-items:center;color:var(--ink-2)}
.img-ph{display:inline-grid;place-items:center;width:44px;height:32px;border:1px dashed var(--rule-strong);border-radius:var(--r-sm);background:var(--sheet-2);color:var(--ink-3)}
.blk.req{display:flex;align-items:center;gap:var(--s2);font-size:var(--t-xs);color:var(--ink-2);margin:var(--s2) 0 0}
.blk.req::before,.blk.req::after{content:"";flex:1 1 var(--s4);border-top:1px solid var(--rule-strong)}
.blk.req::before{flex:0 0 var(--s4)}
.blk.req span{overflow-wrap:anywhere}
details.blk>summary{font-size:var(--t-xs)}
details.blk[open]>summary{margin-bottom:var(--s1)}
.blk.thinking{color:var(--ink-2)}
.blk.tc{border:1px solid var(--rule);border-radius:var(--r-md);background:var(--sheet);padding:var(--s2) var(--s3)}
.tc-head{display:flex;flex-wrap:wrap;gap:var(--s2);align-items:center}
.tc-name{font-family:var(--mono);font-size:var(--t-sm)}
.tc-dur{margin-left:auto;font-size:var(--t-xs)}
.tc-args,.tc-res{margin-top:var(--s1)}
.tc pre{max-height:360px}
.blk.compaction{border-left:3px solid var(--warn);padding-left:var(--s3)}
.blk.sysch{border-left:3px solid var(--queued);padding-left:var(--s3)}
.blk.end{text-align:center;margin-top:var(--s2)}
.blk.ev{color:var(--ink-2);font-size:var(--t-xs);display:flex;gap:var(--s2);align-items:center}
.blk.ev.failed{color:var(--fail)}
.load-row{display:flex;flex-wrap:wrap;gap:var(--s2);align-items:center;margin-top:var(--s1)}
.load-note{font-size:var(--t-xs);color:var(--ink-3)}
.load-note.err{color:var(--fail)}
.phase-nav{display:flex;flex-wrap:wrap;gap:var(--s2);align-items:center;margin-bottom:var(--s4);font-size:var(--t-sm)}
.phase-nav .pill{font-size:var(--t-sm);padding:2px 10px;text-decoration:none}
.phase-nav .pill.on{background:var(--carbon-soft);border-color:var(--carbon);color:var(--ink);font-weight:600}
.pbar{display:flex;align-items:center;gap:var(--s2);min-width:120px}
.pbar .ctx-track{flex:1 1 80px;height:8px}
.pbar .ctx-fill{background:var(--carbon)}
.pbar-n{font-size:var(--t-xs);color:var(--ink-2);min-width:3em;text-align:right}
.ctx-msgs .msg-cell{min-width:240px;max-width:640px}
.ctx-cats tr.unexplained td{color:var(--ink-2);border-top:1px dashed var(--rule-strong)}
ul.notes{margin:0;padding-left:var(--s5);font-size:var(--t-sm);color:var(--ink-2)}

/* ── 记忆（设计 §5）：时间线三条轨、空白、保留边界；检索两级证据 ── */
.aging-card h2 small{font-weight:400}
.mem-tools .tool-link{display:flex;flex-direction:column;gap:2px;text-decoration:none;color:var(--ink)}
.mem-tools .tool-link small{color:var(--ink-2)}
.mem-tools a.tool-link:hover{border-color:var(--carbon)}
.mem-tools .tool-link.off{color:var(--ink-3);border-style:dashed}
.range-nav{margin-top:var(--s4)}
.range-form{display:flex;flex-wrap:wrap;gap:var(--s2);align-items:flex-end;margin-left:auto}
.range-form label{flex-direction:row;align-items:center;gap:var(--s1);font-size:var(--t-sm)}
.mtl{min-height:220px;padding:var(--s2);overflow:hidden}
.mtl .placeholder{padding:var(--s4)}
.mtl .vis-timeline{border:0;font-family:var(--font);font-size:var(--t-xs);color:var(--ink)}
.mtl .vis-panel.vis-center,.mtl .vis-panel.vis-left,.mtl .vis-panel.vis-top,.mtl .vis-panel.vis-bottom,.mtl .vis-panel.vis-right{border-color:var(--rule)}
.mtl .vis-time-axis .vis-text,.mtl .vis-labelset .vis-label{color:var(--ink-2)}
.mtl .vis-time-axis .vis-grid.vis-minor{border-color:var(--rule)}
.mtl .vis-time-axis .vis-grid.vis-major{border-color:var(--rule-strong)}
.mtl .vis-labelset .vis-label,.mtl .vis-foreground .vis-group{border-bottom-color:var(--rule)}
.mtl-group{font-weight:600;color:var(--ink);padding:0 var(--s2)}
.mtl .vis-item{border-radius:var(--r-sm);font-size:var(--t-xs);color:var(--ink);cursor:pointer}
.mtl .vis-item .vis-item-content{padding:1px 4px}
.mtl .vis-item.m-raw{border-color:var(--carbon);background:color-mix(in srgb,var(--carbon) 14%,var(--sheet))}
.mtl .vis-item.m-raw.d2{background:color-mix(in srgb,var(--carbon) 32%,var(--sheet))}
.mtl .vis-item.m-raw.d3{background:color-mix(in srgb,var(--carbon) 55%,var(--sheet));color:var(--sheet)}
.mtl .vis-item.m-raw.d4{background:var(--carbon);color:var(--sheet)}
.mtl .vis-item.m-day{border-color:var(--ok);background:var(--ok-soft)}
.mtl .vis-item.m-week{border-color:var(--queued);background:var(--queued-soft)}
.mtl .vis-item.vis-selected{border-color:var(--warn);box-shadow:0 0 0 2px var(--warn-soft)}
.mtl .vis-item.vis-background{cursor:default;border:0;border-radius:0}
.mtl .vis-item.vis-background.gap-purged{background:repeating-linear-gradient(135deg,var(--fail-soft) 0 6px,transparent 6px 12px)}
.mtl .vis-item.vis-background.gap-none{background:var(--sheet-2)}
.mtl .gap-label{font-size:11px;color:var(--ink-3)}
.mtl .vis-custom-time{width:2px;cursor:default;pointer-events:none}
.mtl .vis-custom-time.edge-raw{background-color:var(--warn)}
.mtl .vis-custom-time.edge-sum,.mtl .vis-custom-time.edge-week{background-color:var(--fail)}
.mtl .vis-custom-time-marker{font-size:11px;padding:1px 4px;border-radius:0 var(--r-sm) var(--r-sm) 0;color:var(--sheet)}
.mtl .vis-current-time{background-color:var(--carbon)}
div.vis-tooltip{font-family:var(--font);font-size:var(--t-xs);color:var(--ink);background:var(--sheet);border:1px solid var(--rule-strong);border-radius:var(--r-md);box-shadow:var(--shadow);padding:var(--s2) var(--s3);white-space:normal;max-width:360px}
.mtl-tip b{display:block;margin-bottom:2px}
.mtl-legend{display:flex;flex-wrap:wrap;gap:var(--s2) var(--s4);margin-top:var(--s2)}
.mtl-legend span{display:inline-flex;align-items:center;gap:6px}
.lg{display:inline-block;width:18px;height:10px;border-radius:2px;border:1px solid var(--rule-strong)}
.lg-raw{background:var(--carbon);border-color:var(--carbon)} .lg-day{background:var(--ok-soft);border-color:var(--ok)} .lg-week{background:var(--queued-soft);border-color:var(--queued)}
.lg-purged{background:repeating-linear-gradient(135deg,var(--fail-soft) 0 3px,transparent 3px 6px)} .lg-none{background:var(--sheet-2)}
.lg-edge{width:3px;height:14px;border:0;background:var(--warn)}
.mtl-actions{margin-top:var(--s2)}
ol.msgs{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--s2)}
.msgs .msg{background:var(--sheet);border:1px solid var(--rule);border-radius:var(--r-md);padding:var(--s2) var(--s3)}
.msg-head{display:flex;flex-wrap:wrap;gap:var(--s1) var(--s3);align-items:baseline;font-size:var(--t-sm)}
.msg-head time{color:var(--ink-2)}
.msg-id{margin-left:auto}
.msg-text,.sum-text{white-space:pre-wrap;overflow-wrap:anywhere}
.sum-text{max-width:var(--measure)}
.hint.err{color:var(--fail)}
.levels{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:var(--s2) var(--s3);align-items:baseline;margin-bottom:var(--s5);font-size:var(--t-sm)}
.levels .hint{grid-column:1/-1;margin:0}
.lv{display:inline-block;padding:0 8px;border-radius:var(--r-sm);font-size:var(--t-xs);font-weight:700;border:1.5px solid currentColor;white-space:nowrap}
.lv-1{color:var(--carbon)} .lv-2{color:var(--ok)} .lv-3{color:var(--ink-3);border-style:dashed}
ol.hits{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--s2)}
.hit-head{display:flex;flex-wrap:wrap;gap:var(--s1) var(--s3);align-items:baseline;font-size:var(--t-sm)}
.hit-head .mono{margin-left:auto}
.hit-text{margin-top:var(--s1);white-space:pre-wrap;overflow-wrap:anywhere}
mark{background:var(--warn-soft);color:inherit;border-bottom:2px solid var(--warn);padding:0 1px}
.tool-panel .gauge{display:flex;align-items:center;gap:var(--s3);margin-bottom:var(--s2);font-size:var(--t-sm)}
.tool-panel meter{flex:1 1 160px;height:12px}
.tool-text{max-height:640px}
.search-cols>section{margin-top:0}
.flash.warn{border-color:var(--warn);background:var(--warn-soft)}
ol.lin-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--s2)}
.lin-ids{margin:var(--s1) 0 0;overflow-wrap:anywhere;max-height:240px;overflow:auto}
@media (max-width:900px){
  .turns-layout{grid-template-columns:minmax(0,1fr)}
  .tdir{position:static;max-height:280px}
}

@media (max-width:720px){
  .top-in{padding:0 var(--s4);gap:var(--s3);flex-wrap:wrap}
  nav.tabs{margin-left:0;width:100%;order:2}
  nav.tabs a{padding:var(--s2) var(--s2)}
  main{padding:var(--s5) var(--s4) var(--s6)}
  h1{font-size:var(--t-lg)}
  .figure{font-size:var(--t-xl)}
  .list .hide-sm{display:none}
  .thumbs img{width:44vw;height:44vw}
  .choice{min-width:100%}
  blockquote.said{font-size:var(--t-md)}
  .ctx-mini{max-width:none;flex-basis:100%}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

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

/* ── 日志 ── */
.log{font-family:var(--mono);font-size:var(--t-xs);background:var(--sheet);border:1px solid var(--rule);border-radius:var(--r-md);max-height:70vh;overflow:auto;padding:var(--s2) 0}
.log div{padding:1px var(--s4);white-space:pre-wrap;overflow-wrap:anywhere;border-left:3px solid transparent}
.log .warn{border-left-color:var(--warn)} .log .error{border-left-color:var(--fail);background:var(--fail-soft)} .log .debug{color:var(--ink-3)}

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
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

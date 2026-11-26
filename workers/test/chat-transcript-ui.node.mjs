import {test} from "node:test";
import assert from "node:assert/strict";
import {ADMIN_PAGE_HTML} from "../src/admin/app.generated.ts";
import {bundleModule,mountDom} from "./browser-harness.mjs";

test("会话对话和刷新使用相同来源标签、待入模项原位更新而非追加",async()=>{
  const {document,click}=mountDom(ADMIN_PAGE_HTML,{token:"synthetic-admin-test"});
  const {initConsole,loadChat,cs}=await bundleModule({contents:
    'export {initConsole,cs} from "./browser/console";export {loadChat} from "./browser/trace";'});
  const card=(id,source,text,status=null)=>({id,source,text,status,role:source==="agent-out"?"assistant":"user",name:"合成",assets:[],at:123,turnId:null});
  let requests=0,paths=[];
  globalThis.fetch=async path=>{
    if(path.startsWith("/admin/threads/owner/chat")){
      paths.push(path);requests++;
      const rows=[card("internal:1","agent-in",requests===1?"尚无入模记录":"已进入模型",requests===1?"waiting":"done"),
        card("agent-out:4","agent-out","合成发件","accepted"),card("internal:3","github","合成事件")];
      return Response.json({messages:rows,active:0,revision:7,delta:path.includes("?")});
    }
    return Response.json([]);
  };
  initConsole();await click(document.querySelector('[data-view="chat"]'));
  const panel=document.getElementById("chat-messages"),labels=()=>[...panel.querySelectorAll(".message-meta")].map(el=>el.textContent);
  assert.ok(panel.textContent.includes("等待进入模型"));
  await loadChat();assert.match(paths[1],/revision=7/);assert.match(paths[1],/pending=internal%3A1/);
  assert.ok(panel.textContent.includes("已进入模型"));assert.equal(panel.querySelectorAll("article").length,3);
  assert.ok(labels().some(s=>s.includes("Agent 发件")&&s.includes("对端已入箱（非已读）")));
  assert.ok(labels().some(s=>s.includes("GitHub 事件")));assert.ok(labels().every(s=>!s.includes("QQ")));
  const before=panel.textContent;await click(document.getElementById("chat-reload"));
  assert.equal(paths.at(-1),"/admin/threads/owner/chat");assert.equal(panel.textContent,before);
  clearTimeout(cs.timer);
});

test("回合执行区将多次 update_steps 收敛为单张实时步骤卡片，区分执行中、挂起等待与完成态",async()=>{
  const {document,click}=mountDom(ADMIN_PAGE_HTML,{token:"synthetic-admin-test"});
  const {initConsole,loadChat,cs}=await bundleModule({contents:
    'export {initConsole,cs} from "./browser/console";export {loadChat} from "./browser/trace";'});
  let phase=1;
  const turnId="turn:step-demo";
  const paths=[];
  globalThis.fetch=async path=>{
    paths.push(path);
    if(path.startsWith("/admin/threads/owner/chat")){
      return Response.json({
        messages:[{id:"web:1",role:"user",source:"web",name:"管理员",text:"并行检查并汇报",at:1000,status:phase<3?"queued":"done",turnId,assets:[]}],
        active:phase===1?1:0,
        revision:1,
        delta:false,
      });
    }
    if(path.startsWith("/admin/threads/owner/progress")){
      return Response.json([{turnId,active:phase===1,steps:[
        {title:"派发子任务检查服务",status:phase===3?"done":"in_progress"},
        {title:"核对日志与指标",status:phase===3?"skipped":"pending"},
        {title:"向用户汇报结论",status:phase===3?"done":"pending"},
      ]}]);
    }
    if(path.startsWith("/admin/agent-traces?"))return Response.json({traces:[]});
    return Response.json([]);
  };

  initConsole();await click(document.querySelector('[data-view="chat"]'));
  const panel=document.getElementById("chat-messages");
  // 阶段 1：运行中显示 0/3 steps · 执行中，in_progress 步为活跃态，且不重复渲染 update_steps 折叠块
  assert.equal(panel.querySelectorAll(".trace-steps").length,1);
  assert.equal(panel.querySelector(".trace-steps-count").textContent,"0/3 steps");
  assert.equal(panel.querySelector(".trace-steps-state").textContent,"执行中");
  assert.ok(panel.querySelector(".trace-step.is-in_progress"));
  assert.equal(panel.querySelectorAll("details[data-tool]").length,0);

  // 阶段 2：回合让出等待子任务唤醒，in_progress 步切换为 paused 等待态（‖）
  phase=2;await loadChat();
  assert.equal(panel.querySelector(".trace-steps-state").textContent,"等待继续");
  assert.equal(panel.querySelector(".trace-step.is-paused .trace-step-icon").textContent,"‖");

  // 阶段 3：后续 update_steps 全量覆盖为完成/跳过，展示 3/3 steps · 已完成
  phase=3;await loadChat();
  assert.equal(panel.querySelectorAll(".trace-steps").length,1);
  assert.equal(panel.querySelector(".trace-steps-count").textContent,"3/3 steps");
  assert.equal(panel.querySelector(".trace-steps-state").textContent,"已完成");
  await click(panel.querySelector("[data-turn] button"));
  const query=new URL(paths.find(p=>p.startsWith("/admin/agent-traces?")), "https://local").searchParams;
  assert.equal(query.get("turn"),turnId);assert.equal(query.get("thread"),"owner");
  assert.ok(!paths.some(p=>p.includes("/trace?")||p.startsWith("/admin/requests?")));
  clearTimeout(cs.timer);
});

test("用量页只查聚合，打开链路时传递原筛选并支持清除",async()=>{
  const {document,click}=mountDom(ADMIN_PAGE_HTML,{token:"synthetic-admin-test"});
  const {initConsole,initExecutions}=await bundleModule({contents:
    'export {initConsole} from "./browser/console";export {initExecutions} from "./browser/executions";'});
  const paths=[];
  globalThis.fetch=async path=>{
    paths.push(path);
    if(path.startsWith("/admin/agent-traces?"))return Response.json({traces:[]});
    return Response.json({summary:{requests:0,failed:0,running:0,measured:0,inputTokens:0,outputTokens:0,cacheRead:0,cacheInputTokens:0,cacheMeasured:0,avgDuration:null},
      series:[],models:[],choices:["faux/test"],bucket:3600000,retainedSince:null});
  };
  initConsole();initExecutions();await click(document.querySelector('[data-view="usage"]'));
  assert.equal(paths.length,1);assert.match(paths[0],/^\/admin\/usage\?/);
  document.querySelector("#req-model").value="faux/test";document.querySelector("#req-purpose").value="subagent";
  document.querySelector("#req-status").value="error";document.querySelector("#req-range").value="168";
  await click(document.querySelector("#usage-executions"));
  const q=new URL(paths.at(-1),"https://local").searchParams;
  assert.equal(q.get("model"),"faux/test");assert.equal(q.get("purpose"),"subagent");assert.equal(q.get("status"),"error");
  assert.equal(Number(q.get("until"))-Number(q.get("since")),168*3600000);
  await click(document.querySelector("#execution-scope-clear"));
  assert.ok(!new URL(paths.at(-1),"https://local").searchParams.has("purpose"));assert.equal(document.querySelector("#request-rows"),null);
});

test("执行链路从根回合展开子任务，可筛选 Pi 调用并导出相同的父子边",async()=>{
  const {document,click,settle}=mountDom(ADMIN_PAGE_HTML,{token:"synthetic-admin-test"});
  const {initConsole,initExecutions,openExecutions,exportExecution}=await bundleModule({contents:
    'export {initConsole} from "./browser/console";export {initExecutions,openExecutions} from "./browser/executions";export {exportExecution} from "./browser/execution-tree";'});
  const summary={thread:"owner",root:"turn:3",started:100,last:180,running:0,failures:0,requests:2,tools:1,children:1,input:100,output:12,cost:null,priced:0,cached:40,cacheInput:80,measured:1};
  const base={id:"m1",kind:"model",actor:"thread",turn:"turn:3",inputId:"qq:1",label:"faux/root",status:"done",started:100,ended:110,input:80,output:10,cached:40,written:null,cost:null,firstEvent:5,alarmWait:null,reasoning:null,callId:"",calls:["c1"],parentCall:"",dispatch:""};
  const tool={...base,id:"t1",kind:"tool",label:"subagent",callId:"c1",calls:[],started:110,ended:120};
  const child={...base,id:"m2",actor:"child-a",turn:"turn:sub:a:1",inputId:"task",label:"faux/child",dispatch:"t1",calls:[],started:121,ended:180};
  const rows=[base,tool,child],paths=[];let paginate=false;
  globalThis.fetch=async path=>{
    paths.push(path);
    if(path.startsWith("/admin/agent-traces/detail"))return Response.json(!paginate?{observations:rows}:path.includes("cursor=")?{observations:[tool,child]}:{observations:[base],next:"page2"});
    if(path.startsWith("/admin/agent-traces/runtime"))return Response.json({spans:[]});
    return Response.json({traces:[summary,{...summary,root:"turn:other"}]});
  };
  initConsole();initExecutions();await click(document.querySelector('[data-view="executions"]'));await settle();
  assert.match(document.querySelector("#execution-detail").textContent,/50.0%/);
  const row=[...document.querySelectorAll(".execution-node")].find(x=>x.textContent.includes("faux/child"));assert.ok(row);await click(row);
  await click([...document.querySelectorAll(".execution-evidence button")].find(x=>x.textContent.includes("原生 span")));
  assert.ok(paths.at(-1).includes("input=task")&&paths.at(-1).includes("request=m2"));
  paginate=true;openExecutions({record:"t1"});await settle();
  assert.equal(document.querySelector('.execution-node[aria-current="true"]').dataset.observation,"t1");
  assert.match(document.querySelector(".execution-evidence").textContent,/subagent/);
  const beforeSwitch=paths.length;
  await click(document.querySelectorAll(".execution-item")[1]);
  const switched=paths.slice(beforeSwitch).map(path=>new URL(path,"https://local").searchParams);
  assert.equal(switched.length,1);
  assert.equal(switched[0].get("root"),"turn:other");
  assert.equal(switched[0].has("cursor"),false);
  assert.equal(document.querySelector('.execution-node[aria-current="true"]'),null);
  const native={trace:"1".repeat(32),id:"2".repeat(16),parent:"3".repeat(16),actor:"child-a",inputId:"task",
    name:"pi.ai.request",started:122,ended:175,status:"ok",attrs:{"request.id":"m2"},
    events:[{name:"pi.ai.first_chunk",at:130,attrs:{index:1}}],links:[{trace:"4".repeat(32),id:"5".repeat(16)}],omitted:0};
  const packet=await exportExecution(summary,rows,[native]), scopes=packet.resourceSpans[0].scopeSpans, spans=scopes[0].spans;
  assert.equal(new Set(spans.map(s=>s.traceId)).size,1);
  assert.ok(spans.every(s=>/^[a-f0-9]{16}$/.test(s.spanId)&&/^[a-f0-9]{32}$/.test(s.traceId)));
  const childSpan=spans.find(s=>s.name==="chat faux/child"),childAgent=spans.find(s=>s.spanId===childSpan.parentSpanId);
  assert.equal(spans.find(s=>s.spanId===childAgent.parentSpanId).name,"execute_tool subagent");
  const pi=scopes[1].spans[0];
  assert.equal(pi.traceId,native.trace);assert.equal(pi.parentSpanId,native.parent);
  assert.equal(pi.events[0].timeUnixNano,"130000000");
  assert.deepEqual(pi.links,[{traceId:native.links[0].trace,spanId:native.links[0].id},{traceId:childSpan.traceId,spanId:childSpan.spanId}]);
});

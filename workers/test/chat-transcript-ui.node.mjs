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
  const binding={turnId,inputId:"web:1",generation:0};
  globalThis.fetch=async path=>{
    if(path.startsWith("/admin/threads/owner/chat")){
      return Response.json({
        messages:[{id:"web:1",role:"user",source:"web",name:"管理员",text:"并行检查并汇报",at:1000,status:phase<3?"queued":"done",turnId,assets:[]}],
        active:phase===1?1:0,
        revision:1,
        delta:false,
      });
    }
    if(path.startsWith("/admin/threads/owner/trace")){
      if(phase===1){
        return Response.json({
          requests:[{id:"req-1",thread:"owner",actor:"thread",purpose:"conversation",startedAt:1001,endedAt:null,provider:"faux",model:"test",status:"running",inputTokens:10,outputTokens:5,cacheRead:0,cacheWrite:0,durationMs:null,contextWindow:128000,binding}],
          tools:[
            {id:"t-step-1",thread:"owner",actor:"thread",binding,callId:"c1",name:"update_steps",startedAt:1002,endedAt:1003,status:"done",steps:[
              {title:"派发子任务检查服务",status:"in_progress"},
              {title:"核对日志与指标",status:"pending"},
              {title:"向用户汇报结论",status:"pending"},
            ]},
            {id:"t-sub-1",thread:"owner",actor:"thread",binding,callId:"c2",name:"subagent",argumentPreview:"spawn",startedAt:1002,endedAt:null,status:"running"},
          ],
          cursor:1,more:false,
        });
      }
      if(phase===2){
        return Response.json({
          requests:[{id:"req-1",thread:"owner",actor:"thread",purpose:"conversation",startedAt:1001,endedAt:1010,provider:"faux",model:"test",status:"done",inputTokens:10,outputTokens:5,cacheRead:0,cacheWrite:0,durationMs:9,contextWindow:128000,binding}],
          tools:[
            {id:"t-step-1",thread:"owner",actor:"thread",binding,callId:"c1",name:"update_steps",startedAt:1002,endedAt:1003,status:"done",steps:[
              {title:"派发子任务检查服务",status:"in_progress"},
              {title:"核对日志与指标",status:"pending"},
              {title:"向用户汇报结论",status:"pending"},
            ]},
            {id:"t-sub-1",thread:"owner",actor:"thread",binding,callId:"c2",name:"subagent",argumentPreview:"spawn",startedAt:1002,endedAt:1008,status:"done"},
          ],
          cursor:2,more:false,
        });
      }
      return Response.json({
        requests:[{id:"req-1",thread:"owner",actor:"thread",purpose:"conversation",startedAt:1001,endedAt:1020,provider:"faux",model:"test",status:"done",inputTokens:10,outputTokens:5,cacheRead:0,cacheWrite:0,durationMs:19,contextWindow:128000,binding}],
        tools:[
          {id:"t-step-2",thread:"owner",actor:"thread",binding,callId:"c3",name:"update_steps",startedAt:1015,endedAt:1016,status:"done",steps:[
            {title:"派发子任务检查服务",status:"done"},
            {title:"核对日志与指标",status:"skipped"},
            {title:"向用户汇报结论",status:"done"},
          ]},
        ],
        cursor:3,more:false,
      });
    }
    return Response.json([]);
  };

  initConsole();await click(document.querySelector('[data-view="chat"]'));
  const panel=document.getElementById("chat-messages");
  // 阶段 1：运行中显示 0/3 steps · 执行中，in_progress 步为活跃态，且不重复渲染 update_steps 折叠块
  assert.equal(panel.querySelectorAll(".trace-steps").length,1);
  assert.equal(panel.querySelector(".trace-steps-count").textContent,"0/3 steps");
  assert.equal(panel.querySelector(".trace-steps-state").textContent,"执行中");
  assert.ok(panel.querySelector(".trace-step.is-in_progress"));
  assert.equal(panel.querySelectorAll("details[data-tool]").length,1); // 仅保留真实 subagent 工具块

  // 阶段 2：回合让出等待子任务唤醒，in_progress 步切换为 paused 等待态（‖）
  phase=2;cs.traceTurns="";await loadChat();
  assert.equal(panel.querySelector(".trace-steps-state").textContent,"等待继续");
  assert.equal(panel.querySelector(".trace-step.is-paused .trace-step-icon").textContent,"‖");

  // 阶段 3：后续 update_steps 全量覆盖为完成/跳过，展示 3/3 steps · 已完成
  phase=3;await loadChat();
  assert.equal(panel.querySelectorAll(".trace-steps").length,1);
  assert.equal(panel.querySelector(".trace-steps-count").textContent,"3/3 steps");
  assert.equal(panel.querySelector(".trace-steps-state").textContent,"已完成");
  clearTimeout(cs.timer);
});

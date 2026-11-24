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

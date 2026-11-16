import { el, fail } from "./app";
import { api, readApi } from "./api";
import { Type } from "typebox";
import { parseMemoryTime, formatBeijingTime } from "../src/memory/time";
import type { MemoryEditor } from "../src/memory/editor";

const Scopes=Type.Object({scopes:Type.Array(Type.String())});
const Bindings=Type.Object({bindings:Type.Array(Type.Object({memory_id:Type.Number(),revision:Type.Number(),state:Type.String()}))});
const Proposal=Type.Object({id:Type.String(),payload_hash:Type.String(),payload_json:Type.String(),scope_key:Type.String(),memory_version:Type.Number(),binding_revision:Type.Number()});
/** 独立的精确正文确认；保存普通记忆和模型声称批准都不会经过此入口。 */
export async function ruleEditor(host:HTMLElement,row:MemoryEditor&{id:number},memoryVersion:number) {
  host.replaceChildren(el("p",{text:"正在读取规则管理状态…"}));
  try {
    const {scopes}=await readApi(Scopes,"GET","/admin/memory/rules/scopes");
    if(!scopes.length)throw new Error("未配置主人私聊，不能批准规则。");
    const scope=el("select",{},scopes.map(s=>el("option",{value:s,text:s})));
    const text=el("textarea",{maxlength:500});text.value=row.text;
    const date=(n:number|null|undefined)=>n==null?"":formatBeijingTime(n*1000);
    const since=el("input",{value:date(row.since),placeholder:"生效时间（北京时间）"});
    const until=el("input",{value:date(row.until),placeholder:"失效时间（北京时间）"});
    const status=el("p",{role:"status"}),preview=el("pre"),buttons=el("div",{className:"row"});
    host.replaceChildren(el("p",{text:"仅主人私聊回复约定，不授予工具或隐私权限。批准绑定本页显示的精确正文与版本；历史规则不会批量启用。"}),scope,
      el("label",{},[el("span",{text:"正文"}),text]),el("label",{},[el("span",{text:"生效"}),since]),el("label",{},[el("span",{text:"失效"}),until]),status,preview,buttons);
    let serial=0;
    const load=async()=>{
      const current=++serial,selected=scope.value,q="?ns=owner&scope="+encodeURIComponent(selected);
      buttons.replaceChildren();preview.textContent="";
      const data=await readApi(Bindings,"GET","/admin/memory/rules"+q);
      if(current!==serial)return;
      const binding=data.bindings.find(b=>b.memory_id===row.id),revision=binding?.revision??0;
      status.textContent="记忆版本 "+memoryVersion+" · 批准版本 "+revision+" · "+(binding?.state==="enabled"?"已批准":"未启用");
      const checkReceipt=(requestId:string)=>buttons.append(el("button",{className:"btn",text:"查询操作回执",onclick:async()=>{
        try{const receipt=await api("GET","/admin/memory/rules/receipts/"+requestId+q);status.textContent=receipt?"回执："+JSON.stringify(receipt):"未找到提交回执，请保留请求编号核查；不自动重试。";}catch(e){fail(e);}
      }}));
      const prepare=el("button",{className:"btn",text:"生成精确批准预览",onclick:async()=>{
        if(prepare.disabled)return;prepare.disabled=true;
        const requestId=crypto.randomUUID();
        try{
          const entry:MemoryEditor={kind:"rule",text:text.value,subject:row.subject??null,since:since.value.trim()?parseMemoryTime(since.value.trim()):null,until:until.value.trim()?parseMemoryTime(until.value.trim()):null};
          const p=await readApi(Proposal,"POST","/admin/memory/rules/proposals"+q,{id:row.id,expectedVersion:memoryVersion,expectedBindingRevision:revision,entry,requestId});
          if(current!==serial)return;
          text.disabled=true;since.disabled=true;until.disabled=true;scope.disabled=true;
          preview.textContent="作用域："+p.scope_key+"\n记忆版本："+p.memory_version+"；批准版本："+p.binding_revision+"\n精确正文与有效期：\n"+p.payload_json+"\n正文指纹："+p.payload_hash;
          const confirmationId=crypto.randomUUID();
          const confirm=el("button",{className:"btn primary",text:"我批准以上精确版本和正文",onclick:async()=>{
            if(confirm.disabled)return;confirm.disabled=true;
            try{await api("POST","/admin/memory/rules/confirm"+q,{proposalId:p.id,payloadHash:p.payload_hash,requestId:confirmationId});status.textContent="已保存；下一次成功 prepare 加载。画像旧副本需要复核。请关闭详情并刷新。";}
            catch(e){status.textContent="批准未确认，请查回执后核对，禁止直接重复操作。请求："+confirmationId;checkReceipt(confirmationId);fail(e);}
          }});
          buttons.replaceChildren(confirm);
        }catch(e){status.textContent="生成失败或结果未确认，请保留请求编号核查："+requestId;checkReceipt(requestId);fail(e);}
      }});
      buttons.append(prepare);
      if(binding?.state==="enabled") {
        const requestId=crypto.randomUUID();
        const revoke=el("button",{className:"btn danger",text:"撤销此批准版本",onclick:async()=>{
          if(revoke.disabled || !window.confirm("撤销批准版本 "+revision+"？下一成功 prepare 移除，画像旧副本将待复核；历史记录仍保留。"))return;
          revoke.disabled=true;prepare.disabled=true;scope.disabled=true;
          try{await api("POST","/admin/memory/rules/revoke"+q,{id:row.id,expectedVersion:memoryVersion,expectedBindingRevision:revision,requestId});status.textContent="已撤销；下一成功 prepare 生效。请关闭详情并刷新，复核画像。";}
          catch(e){status.textContent="撤销结果未确认，请查询回执："+requestId;checkReceipt(requestId);fail(e);}
        }});buttons.append(revoke);
      }
    };
    scope.addEventListener("change",()=>{void load().catch(fail);});
    await load();
  }catch(e){host.replaceChildren(el("p",{text:"无法读取规则状态；未进行批准。"}));fail(e);}
}

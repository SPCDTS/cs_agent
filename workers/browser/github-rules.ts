import { Check } from "typebox/value";
import { CapabilitiesSchema } from "../src/github/capability-model";
import { RuleSchema, reservedEvent, type GitHubRule } from "../src/github/rules";
import type { GitHubView } from "./app-contracts";
import { el } from "./dom";
import { api } from "./api";
import { fail, bjTime } from "./app";

export const checkLabel = (text:string,box:HTMLInputElement) => el("label",{className:"github-check"},[box,el("span",{text})]);
export function rulesEditor(value:GitHubView["value"], initial:GitHubView["capabilities"]) {
  let capabilities=initial;
  const list=el("div",{className:"github-rules"}), candidates=el("datalist",{id:"github-event-candidates"}), status=el("div",{className:"muted small"});
  const rows:{node:HTMLElement;event:HTMLInputElement;actions:HTMLInputElement;subject:HTMLSelectElement}[]=[];
  const add=(rule?:GitHubRule)=>{
    if(rows.length>=100)throw new Error("最多100条自定义规则");
    const event=el("input",{type:"text",list:"github-event-candidates",value:rule?.event??"",placeholder:"事件名称（精确）",maxLength:40});
    const actions=el("input",{type:"text",value:rule?(rule.actions==="*"?"*":rule.actions.map(a=>a||"<none>").join(",")):"",placeholder:"必填：* 或 created,edited；<none> 无action"});
    const subject=el("select",{},["any","issue","pull_request"].map(v=>el("option",{value:v,text:v,selected:v===(rule?.subject??"any")})));

    const node=el("div",{className:"row"},[el("label",{className:"field"},[el("span",{text:"event"}),event]),
      el("label",{className:"field"},[el("span",{text:"actions（显式必填）"}),actions]),
      el("label",{className:"field"},[el("span",{text:"issue_comment 类型（其他事件仅any）"}),subject])]);
    const row={node,event,actions,subject};rows.push(row);
    node.append(el("button",{type:"button",className:"btn",text:"删除此规则",onclick:()=>{rows.splice(rows.indexOf(row),1);node.remove();}}));list.append(node);
  };
  for(const rule of value.rules??[])add(rule);
  const renderCapabilities=()=>{
    const c=capabilities,reads=c?[{name:"App",read:c.app},...c.installations.map(i=>({name:"安装 #"+i.installationId,read:i.read}))]:[];
    const names=new Set<string>([...value.selections.map(s=>s.split(".")[0]!),...(value.rules??[]).map(r=>r.event)]);
    for(const item of reads)for(const name of item.read.data?.events??[])names.add(name);
    candidates.replaceChildren(...[...names].sort().filter(n=>!reservedEvent(n)).map(value=>el("option",{value})));
    status.replaceChildren(...(reads.length?reads.map(({name,read})=>el("p",{text:name+" · "+read.status+" · 成功读取："+(read.fetchedAt?bjTime(read.fetchedAt):"从未")+
      " · 上次尝试："+(read.lastAttemptAt?bjTime(read.lastAttemptAt):"无")+(read.error?" · "+read.error:"")+
      " · events："+(read.data?read.data.events.join(", ")||"明确空列表":"未知")+
      " · permissions："+(read.data?JSON.stringify(read.data.permissions):"未知")+
      (read.data?.repositorySelection?" · 仓库范围："+read.data.repositorySelection:"")+
      (read.data?.suspendedAt?" · suspended_at："+read.data.suspendedAt:"")})):[el("p",{text:"上游快照 never：尚未读取，不能当作未订阅。"})]));
    if(c) {
      const configured=new Set([...value.selections.map(s=>s.split(".")[0]!),...(value.rules??[]).map(r=>r.event)]);
      const selectedInstalls=new Set(value.repositoryIds.map(r=>r.installationId));
      for(const {name,read} of reads.filter(x=>x.name==="App"||selectedInstalls.has(Number(x.name.replace("安装 #","")))))
        if(read.status==="fresh"&&read.data)for(const event of configured)if(!read.data.events.includes(event))
          status.append(el("p",{text:name+" 当前快照未列出 "+event+"：本地规则仍保留，检查上游订阅/安装批准；不据此拒收已授权事件。"}));
    }
  };
  renderCapabilities();
  const refresh=el("button",{type:"button",className:"btn",text:"读取 / 刷新上游订阅",onclick:async()=>{
    try { const result=await api("POST","/admin/github/capabilities/refresh",{});
      if(!Check(CapabilitiesSchema,result))throw new Error("invalid_capabilities");
      capabilities=result;renderCapabilities();
    } catch(e){fail(e);}
  }});
  const panel=el("div",{},[
    el("p",{text:"上游订阅发现仅提供候选与诊断，不自动启用。本地选择不授予权限；GitHub App 管理员仍需配置事件与权限并完成安装批准。events 不是所有可开启类别或 action 全集，也不保证投递成功。"}),
    refresh,status,candidates,
    el("p",{text:"全部自定义规则（与上面的精确预设 OR 合并）。取消上方预设不会删除这里的规则；若仍有匹配规则，事件仍会通知。清空全部监听必须同时取消预设并删除下面全部规则。旧客户端保存会保留它不认识的这些规则。"}),
    list,
    el("button",{type:"button",className:"btn",text:"新增自定义规则",onclick:()=>add()}),
    ...([{event:"issue_comment",actions:["created"],subject:"pull_request"},{event:"issue_comment",actions:["created"],subject:"issue"},
      {event:"pull_request_review",actions:["submitted"]},{event:"pull_request_review_comment",actions:["created"]}] as GitHubRule[])
      .map((r,i)=>el("button",{type:"button",className:"btn",text:["添加PR普通评论","添加Issue评论","添加PR审核","添加PR行评论"][i],onclick:()=>add(r)})),
    el("p",{className:"muted small",text:"event 精确名称；actions 必填，* 是该事件的全部 action，逗号分隔只匹配列出的 action，<none> 仅匹配没有 action 的事件。没有模板或表达式。"} ),
  ]);
  return {panel,read:():GitHubRule[]=>rows.map(r=>{
    const event=r.event.value.trim(),text=r.actions.value.trim();
    const rule={event,actions:text==="*"?"*" as const:text.split(",").map(a=>a.trim()==="<none>"?"":a.trim()),
      ...(event==="issue_comment"?{subject:r.subject.value as "any"|"issue"|"pull_request"}:{})};
    if(!text||text!== "*"&&text.split(",").some(a=>!a.trim())||!Check(RuleSchema,rule)||reservedEvent(event)||event!=="issue_comment"&&r.subject.value!=="any")throw new Error("invalid_event_rule");
    return rule;
  })};
}

import { Type } from "typebox";
import { Check } from "typebox/value";
import type { GitHubView } from "./app-contracts";
import { el } from "./dom";
import { api, readApi } from "./api";
import { fail, loadSources } from "./app";
import { paginatedBlock } from "./pagination";
const Result = Type.Object({state:Type.String({maxLength:100}),code:Type.String({maxLength:512})});
const Start = Type.Object({url:Type.String(),installationUrl:Type.String()});
export function connectionPanel(view: GitHubView) {
  const c=view.connections;
  const action=(text:string,run:()=>Promise<unknown>)=>el("button",{type:"button",className:"btn",text,onclick:async()=>{try{await run();await loadSources();}catch(e){fail(e);}}});
  const nodes:HTMLElement[]=[el("p",{text:"独立 GitHub App：先安装并授权仓库，再明确连接当前 GitHub 身份。可以添加多个账号和组织安装；仅向本 owner 私聊投递。"}),
    el("p",{text:c.configured?"App 已配置；授权自动安全续期，权限交集定期复验。":"App 未完整配置：拒收。请运营方按 docs/GITHUB-APP-DESIGN.md 配置。"}),
    el("a",{text:"安装 / 调整 App 仓库授权",href:"https://github.com/apps/"+encodeURIComponent(c.slug)+"/installations/new",rel:"noreferrer"}),
    action("连接 / 添加 GitHub 身份",async()=>{
      const browser=Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,"0")).join("");
      const start=await readApi(Start,"POST","/admin/github/connect/start",{browser});
      const url=new URL(start.url);if(url.origin!=="https://github.com"||url.pathname!=="/login/oauth/authorize")throw new Error("invalid_oauth_url");
      sessionStorage.setItem("github-browser",browser);location.assign(url.href);
    })];
  const raw=sessionStorage.getItem("github-oauth-result");
  if(raw) nodes.push(action("确认连接刚授权的 GitHub 身份",async()=>{
    let value:unknown;try{value=JSON.parse(raw);}catch{throw new Error("invalid_callback");}
    if(!Check(Result,value))throw new Error("invalid_callback");
    const browser=sessionStorage.getItem("github-browser")??"";
    try{await api("POST","/admin/github/connect/complete",{...value,browser});}
    finally{sessionStorage.removeItem("github-oauth-result");sessionStorage.removeItem("github-browser");}
  }));
  nodes.push(paginatedBlock("github-identities",c.identities.map(u=>el("div",{},[
    el("span",{text:u.login+" #"+u.id+" "}),
    action("同步 / 恢复此身份安装",()=>api("POST","/admin/github/connect/sync",{userId:u.id})),
    action("撤销此身份",()=>api("POST","/admin/github/connect/disconnect",{kind:"user",id:u.id})),
  ]))));
  nodes.push(paginatedBlock("github-installations",c.installations.map(b=>el("div",{},[
    el("span",{text:"安装 #"+b.installationId+" · "+b.user.login+" · "+b.status+" · 可见仓库 "+b.repositories.length+" "}),
    action("断开此安装",()=>api("POST","/admin/github/connect/disconnect",{kind:"installation",id:b.installationId})),
  ]))));
  return el("div",{},nodes);
}

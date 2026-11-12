import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";

test("GitHub receipts paginate 10/1/back and preserve page and unsaved form", async () => {
  const mock = String.raw`
    class Node {
      constructor(tag, props={}, children=[]) {
        this.tagName=tag.toUpperCase();this.children=[];this.dataset={};Object.assign(this,props);
        if(props["data-list-pager"])this.dataset.listPager=props["data-list-pager"];
        this.classList={contains:value=>(this.className||"").split(" ").includes(value)};
        this.append(...children);
      }
      append(...nodes){for(const n of nodes){if(n.parentElement)n.parentElement.children=n.parentElement.children.filter(x=>x!==n);n.parentElement=this;this.children.push(n);}}
      replaceChildren(...nodes){for(const n of this.children)n.parentElement=null;this.children=[];this.append(...nodes);}
      get nextElementSibling(){const a=this.parentElement?.children||[];return a[a.indexOf(this)+1];}
      after(node){const a=this.parentElement.children;node.parentElement=this.parentElement;a.splice(a.indexOf(this)+1,0,node);}
      querySelector(tag){return this.children.find(n=>n.tagName===tag.toUpperCase())||this.children.map(n=>n.querySelector(tag)).find(Boolean);}
    }


    globalThis.HTMLElement = Node;
    export const el=(...args)=>new Node(...args), bjTime=String;
    export const state={editingSource:null,sourceForms:{}};
    export const api=()=>{},notice=()=>{},fail=()=>{},loadSources=()=>{};
  `;
  const result = await build({
    stdin: { contents: 'export { renderGitHub } from "./browser/github"; export { state } from "./browser/app";',
      resolveDir: fileURLToPath(new URL("..", import.meta.url)) },
    bundle: true, write: false, format: "cjs", platform: "browser",
    plugins: [{ name: "fake-dom", setup(build) {
      build.onResolve({ filter: /(?:^|\/)(?:dom|app|api)$/ }, () => ({ path: "mock", namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: mock, loader: "js" }));
    } }],
  });
  const context = { module: { exports: {} }, TextEncoder, TextDecoder, URL };
  runInNewContext(result.outputFiles[0].text, context);
  const { renderGitHub, state } = context.module.exports;
  const expect=value=>({toBe:expected=>assert.equal(value,expected)});
    const github={configured:true,count:11,capacity:100,pendingCapacity:100,pins:[],revision:"1",
      value:{repositories:["SPCDTS/cs_agent"],paused:false,selections:[],settings:{mergeWindowS:0,budgetPerHour:10}},
      receipts:Array.from({length:11},(_,i)=>({delivery_id:"d"+i,received_at:i,repository:"a/b",event:"issues",state:"held"}))};
    let card=renderGitHub({paused:false},github);
    const body=()=>card.querySelector("tbody");
    const pager=()=>card.children.find(n=>n.dataset.listPager==="true");
    const buttons=()=>pager().children[1].children;
    expect(body().children.length).toBe(10);
    buttons()[1].onclick();
    expect(body().children.length).toBe(1);
    expect(body().children[0].children[1].text).toBe("d10");
    const form=state.sourceForms.github;
    expect(form.querySelector("textarea").value).toBe("SPCDTS/cs_agent");
    state.editingSource="github";form.open=true;form.querySelector("textarea").value="unsaved/repo";
    card=renderGitHub({paused:false},github);
    expect(body().children.length).toBe(1);
    expect(state.sourceForms.github).toBe(form);
    expect(form.querySelector("textarea").value).toBe("unsaved/repo");
    buttons()[0].onclick();
    expect(body().children.length).toBe(10);
    expect(body().children[0].children[1].text).toBe("d0");
    github.receipts=github.receipts.slice(0,1);
    card=renderGitHub({paused:false},github);
    expect(body().children.length).toBe(1);
    expect(pager().hidden).toBe(true);


});

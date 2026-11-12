import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";

test("new admin loadSources reaches typed GitHub config and receipts, paginates 10/1/back and preserves edits", async () => {
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
    export const el=(...args)=>new Node(...args);
    export const nodes={}, $=id=>nodes[id], input=$, clear=node=>node.replaceChildren(), pill=(text,tone)=>el("span",{text,className:tone});
    export const cs={}, consoleView=()=>{},renderConsoleThreads=()=>{},resetConsole=()=>{},startConsole=()=>{};
    export const loadManagement=()=>{},memoryDetail=()=>{},mm={};
  `;
  const result = await build({
    stdin: { contents: 'export { loadSources, renderSources, state } from "./browser/app"; export { el, nodes } from "./browser/dom";',
      resolveDir: fileURLToPath(new URL("..", import.meta.url)) },
    bundle: true, write: false, format: "cjs", platform: "browser",
    plugins: [{ name: "fake-dom", setup(build) {
      build.onResolve({ filter: /(?:^|\/)(?:dom|console|management|memory)$/ }, () => ({ path: "mock", namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: mock, loader: "js" }));
    } }],
  });
  const context = { module: { exports: {} }, TextEncoder, TextDecoder, URL };
  runInNewContext(result.outputFiles[0].text, context);
  const { loadSources, renderSources, state, el, nodes } = context.module.exports;
  const sources=el("div",{id:"sources"});
  el("main",{},[sources]); nodes.sources=sources;
  const expect=value=>({toBe:expected=>assert.equal(value,expected)});
    const github={mode:"manual",connections:{configured:false,slug:"",identities:[],installations:[]},configured:true,count:11,capacity:100,pendingCapacity:100,pins:[],revision:"1",
      value:{repositories:["SPCDTS/cs_agent"],paused:false,selections:[],settings:{intervalS:60,mergeWindowS:0,budgetPerHour:10,filters:{requireLabels:[],excludeLabels:[],excludeSenders:[]}}},
      receipts:Array.from({length:11},(_,i)=>({delivery_id:"d"+i,received_at:i,repository:"a/b",event:"issues",action:"opened",state:"held",reason:null,outcome:null}))};
    const view={sources:[{id:"github",paused:false,degraded:false,cursor:null,lastPollAt:null,held:11,
      budget:{used:0,perHour:10},failures:0,configured:true,settings:github.value.settings}],github,watch:{topic:false,expiration:null},runs:[]};
    context.sessionStorage={getItem:()=>"synthetic-admin-test"};
    context.fetch=async (path,options)=>{
      assert.equal(path,"/admin/event-sources");assert.equal(options.method,"GET");
      return new Response(JSON.stringify(view));
    };
    await loadSources();
    const render=()=>{renderSources(view);return sources.children[0];};
    let card=sources.children[0];
    expect(card.children[0].text).toBe("GitHub webhook");
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
    card=render();
    expect(body().children.length).toBe(1);
    expect(state.sourceForms.github).toBe(form);
    expect(form.querySelector("textarea").value).toBe("unsaved/repo");
    buttons()[0].onclick();
    expect(body().children.length).toBe(10);
    expect(body().children[0].children[1].text).toBe("d0");
    github.receipts=github.receipts.slice(0,1);
    card=render();
    expect(body().children.length).toBe(1);
    expect(pager().hidden).toBe(true);


});

import { expect, it } from "vitest";
import { GITHUB_APP_JS } from "../src/admin/github-ui";
import { PAGINATION_APP_JS } from "../src/admin/pagination-ui";

it("paginates GitHub receipts 10/1/back and preserves page and editing form on refresh", () => {
  const check = new Function("expect", String.raw`
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
    const el=(...args)=>new Node(...args),ADMIN_PAGE_SIZE=10,bjTime=String;
    const state={editingSource:null,sourceForms:{}};
  ` + PAGINATION_APP_JS + GITHUB_APP_JS + String.raw`
    const github={configured:true,count:11,capacity:100,pendingCapacity:100,pins:[],revision:1,
      value:{repositories:[],paused:false,selections:[],settings:{mergeWindowS:0,budgetPerHour:10}},
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
  `);
  check(expect);
});
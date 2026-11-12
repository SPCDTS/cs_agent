import { el } from "./app";
import { ADMIN_PAGE_SIZE } from "../src/admin/pagination";
export const listPages=new Map<string,number>(),listContents=new WeakMap<HTMLElement,Element[]>();
export function listPager(target:HTMLElement):HTMLElement{
  const table=target.tagName==="TBODY"?target.parentElement:null;
  const anchor=table?(table.parentElement?.classList.contains("scroll")?table.parentElement:table):target;
  let bar=anchor.nextElementSibling;
  if(!(bar instanceof HTMLElement)||bar.dataset.listPager!=="true"){bar=el("div",{className:"pager","data-list-pager":"true"});anchor.after(bar);}
  if(!(bar instanceof HTMLElement))throw new Error("missing_list_pager");
  return bar;
}
export function renderListPager(target:HTMLElement,page:number,hasNext:boolean,previous:()=>void,next:()=>void,total?:number){
  const bar=listPager(target);bar.hidden=false;
  bar.replaceChildren(el("span",{className:"muted small",text:"第 "+page+" 页 · 每页 "+ADMIN_PAGE_SIZE+" 条"+(total===undefined?"":" · 共 "+total+" 条")}),
    el("div",{className:"row"},[el("button",{className:"btn compact",type:"button",text:"上一页",disabled:page===1,onclick:previous}),el("button",{className:"btn compact",type:"button",text:"下一页",disabled:!hasNext,onclick:next})]));
  return bar;
}
export function paginateChildren(target:HTMLElement,{key=target.id,attachedRows=false}:{key?:string;attachedRows?:boolean}={}){
  const groups:Element[][]=[];
  for(const node of target.children){
    if(attachedRows&&node.firstElementChild instanceof HTMLTableCellElement&&node.firstElementChild.colSpan>1&&groups.length)groups[groups.length-1].push(node);else groups.push([node]);
  }
  listContents.set(target,groups.flat());
  const pages=Math.max(1,Math.ceil(groups.length/ADMIN_PAGE_SIZE));
  let page=Math.min(listPages.get(key)||1,pages);
  const draw=()=>{
    listPages.set(key,page);target.replaceChildren(...groups.slice((page-1)*ADMIN_PAGE_SIZE,page*ADMIN_PAGE_SIZE).flat());
    const bar=renderListPager(target,page,page<pages,()=>{page--;draw();},()=>{page++;draw();},groups.length);bar.hidden=groups.length<=ADMIN_PAGE_SIZE;
  };draw();
}
export function paginatedBlock(key:string,nodes:HTMLElement[]){
  const target=el("div",{},nodes),box=el("div",{},[target]);paginateChildren(target,{key});return box;
}
export function listInputs(target:HTMLElement,selector:string):HTMLInputElement[]{
  return (listContents.get(target)||[...target.children]).flatMap(node=>[...(node.matches(selector)?[node]:[]),...node.querySelectorAll(selector)]).filter((node):node is HTMLInputElement=>node instanceof HTMLInputElement);
}

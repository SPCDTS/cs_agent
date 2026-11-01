// 管理端列表共用分页；保留离屏表单节点，翻页不会清空尚未保存的勾选。
export const PAGINATION_APP_JS = String.raw`
  const listPages=new Map(),listContents=new WeakMap();
  function listPager(target){
    const table=target.tagName==="TBODY"?target.parentElement:null;
    const anchor=table?(table.parentElement?.classList.contains("scroll")?table.parentElement:table):target;
    let bar=anchor.nextElementSibling;
    if(!bar||bar.dataset.listPager!=="true"){bar=el("div",{className:"pager","data-list-pager":"true"});anchor.after(bar);}
    return bar;
  }
  function renderListPager(target,page,hasNext,previous,next,total){
    const bar=listPager(target);bar.hidden=false;
    bar.replaceChildren(el("span",{className:"muted small",text:"第 "+page+" 页 · 每页 "+ADMIN_PAGE_SIZE+" 条"+(total===undefined?"":" · 共 "+total+" 条")}),
      el("div",{className:"row"},[el("button",{className:"btn compact",type:"button",text:"上一页",disabled:page===1,onclick:previous}),el("button",{className:"btn compact",type:"button",text:"下一页",disabled:!hasNext,onclick:next})]));
    return bar;
  }
  function paginateChildren(target,{key=target.id,attachedRows=false}={}){
    const groups=[];
    for(const node of target.children){
      if(attachedRows&&node.firstElementChild?.colSpan>1&&groups.length)groups[groups.length-1].push(node);else groups.push([node]);
    }
    listContents.set(target,groups.flat());
    const pages=Math.max(1,Math.ceil(groups.length/ADMIN_PAGE_SIZE));
    let page=Math.min(listPages.get(key)||1,pages);
    const draw=()=>{
      listPages.set(key,page);target.replaceChildren(...groups.slice((page-1)*ADMIN_PAGE_SIZE,page*ADMIN_PAGE_SIZE).flat());
      const bar=renderListPager(target,page,page<pages,()=>{page--;draw();},()=>{page++;draw();},groups.length);bar.hidden=groups.length<=ADMIN_PAGE_SIZE;
    };draw();
  }
  function paginatedBlock(key,nodes){
    const target=el("div",{},nodes),box=el("div",{},[target]);paginateChildren(target,{key});return box;
  }
  function listInputs(target,selector){
    return (listContents.get(target)||[...target.children]).flatMap(node=>[...(node.matches(selector)?[node]:[]),...node.querySelectorAll(selector)]);
  }
`;

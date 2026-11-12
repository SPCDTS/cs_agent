import type { AgentFamily, AgentNode } from "./topology-contracts";

const latest = (family: AgentFamily) => Math.max(...(family.children.length ? family.children : [family.parent]).map(node => node.lastActiveAt ?? 0));

/** 保留父子分组；按组内最新活动翻页，后面的组不回填到前面的页。 */
export function topologyPages(nodes: AgentNode[], capacity: number): AgentFamily[][] {
  capacity=Math.max(1,capacity);
  const groups: AgentFamily[]=[],size=Math.min(3,capacity);
  for(const parent of nodes.filter(node=>node.kind==="thread")){
    const children=nodes.filter(node=>node.parentId===parent.id).sort((a,b)=>(b.lastActiveAt??0)-(a.lastActiveAt??0)||a.id.localeCompare(b.id));
    for(let i=0;i<Math.max(1,children.length);i+=size)groups.push({parent,children:children.slice(i,i+size),part:i/size});
  }
  groups.sort((a,b)=>latest(b)-latest(a)||a.parent.id.localeCompare(b.parent.id)||a.part-b.part);
  const pages: AgentFamily[][]=[];
  for(const group of groups){
    let page=pages.at(-1);
    if(!page||page.length>=3||page.reduce((n,g)=>n+Math.max(1,g.children.length),0)+Math.max(1,group.children.length)>capacity||page.some(g=>g.parent.id===group.parent.id)){
      page=[];pages.push(page);
    }
    page.push(group);
  }
  return pages;
}

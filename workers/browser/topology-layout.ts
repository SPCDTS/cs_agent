import type { AgentFamily, AgentNode } from "./topology-contracts";

const latest=(family:AgentFamily)=>Math.max(family.parent.lastActiveAt??0,...family.children.map(node=>node.lastActiveAt??0));

/** 全局只展示最近活动的 5 个子 agent，保留对应父会话与独立活跃的主 agent。 */
export function topologyFamilies(nodes:readonly AgentNode[]):AgentFamily[]{
  const children=nodes.filter(node=>node.kind==="subagent")
    .sort((a,b)=>(b.lastActiveAt??0)-(a.lastActiveAt??0)||a.id.localeCompare(b.id)).slice(0,5);
  return nodes.filter(node=>node.kind==="thread").map(parent=>({
    parent,children:children.filter(node=>node.parentId===parent.id),
  })).filter(family=>family.parent.activity!=="context"||family.children.length>0)
    .sort((a,b)=>latest(b)-latest(a)||a.parent.id.localeCompare(b.parent.id));
}

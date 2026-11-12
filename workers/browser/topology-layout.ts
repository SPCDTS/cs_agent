import type { AgentFamily, AgentNode } from "./topology-contracts";

const latest=(family:AgentFamily)=>Math.max(family.parent.lastActiveAt??0,...family.children.map(node=>node.lastActiveAt??0));

/** 每个父会话只出现一次，所有子节点在同一页内按最近活动排列。 */
export function topologyFamilies(nodes:AgentNode[]):AgentFamily[]{
  return nodes.filter(node=>node.kind==="thread").map(parent=>({
    parent,
    children:nodes.filter(node=>node.kind==="subagent").filter(node=>node.parentId===parent.id)
      .sort((a,b)=>(b.lastActiveAt??0)-(a.lastActiveAt??0)||a.id.localeCompare(b.id)),
  })).sort((a,b)=>latest(b)-latest(a)||a.parent.id.localeCompare(b.parent.id));
}

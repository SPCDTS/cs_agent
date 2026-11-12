import { expect, it } from "vitest";
import { topologyFamilies } from "../browser/topology-layout";
import type { AgentNode } from "../browser/topology-contracts";

const parent=(thread:string):AgentNode=>({id:"thread:"+thread,thread,kind:"thread",parentId:null,activity:"context",lastActiveAt:null});
const child=(thread:string,actor:string,at:number|null):AgentNode=>({id:"sub:"+thread+":"+actor,thread,kind:"subagent",parentId:"thread:"+thread,actor,activity:"recent",lastActiveAt:at,status:"done",summary:null,description:null});

it("单页保留所有父子节点，每个父会话只出现一次，组内及组间按最近活动排序",()=>{
  const nodes=[parent("a"),parent("z"),parent("m"),child("a","older",10),...[...Array(20).keys()].map(i=>child("z",String(i),100-i)),child("m","task",80)];
  const families=topologyFamilies(nodes);
  expect(families.map(group=>group.parent.thread)).toEqual(["z","m","a"]);
  expect(families[0].children.map(node=>node.id)).toEqual([...Array(20).keys()].map(i=>"sub:z:"+i));
  expect(families.flatMap(group=>[group.parent,...group.children])).toHaveLength(nodes.length);
  expect(new Set(families.flatMap(group=>[group.parent,...group.children]).map(node=>node.id)).size).toBe(nodes.length);
});

it("新活动使整个父子组前移，时间相同时顺序稳定，无子节点的父会话仍可见",()=>{
  const nodes=[parent("owner"),parent("empty"),child("owner","z",null),child("owner","b",5),child("owner","a",5)];
  expect(topologyFamilies(nodes)[0].children.map(node=>node.id)).toEqual(["sub:owner:a","sub:owner:b","sub:owner:z"]);
  nodes[1].lastActiveAt=20;
  expect(topologyFamilies(nodes).map(group=>group.parent.thread)).toEqual(["empty","owner"]);
  nodes.push(child("owner","recent",30));
  expect(topologyFamilies(nodes)[0].children[0].id).toBe("sub:owner:recent");
  expect(topologyFamilies([])).toEqual([]);
});

import { expect, it } from "vitest";
import { topologyFamilies } from "../browser/topology-layout";
import type { AgentNode } from "../browser/topology-contracts";

const parent=(thread:string):AgentNode=>({id:"thread:"+thread,thread,kind:"thread",parentId:null,activity:"context",lastActiveAt:null});
const child=(thread:string,actor:string,at:number|null):Extract<AgentNode,{kind:"subagent"}>=>({id:"sub:"+thread+":"+actor,thread,kind:"subagent",parentId:"thread:"+thread,actor,activity:"recent",lastActiveAt:at,status:"done",summary:null,description:null});

it("跨父会话只展示最近活动的五个子 agent，保留父子关系且不重复父节点",()=>{
  const nodes=[parent("a"),parent("z"),parent("m"),child("a","older",10),...[...Array(20).keys()].map(i=>child("z",String(i),100-i)),child("m","task",98.5)];
  const original=nodes.map(node=>node.id),families=topologyFamilies(nodes);
  expect(families.map(group=>group.parent.thread)).toEqual(["z","m"]);
  expect(families.flatMap(group=>group.children.map(node=>node.id))).toEqual(["sub:z:0","sub:z:1","sub:z:2","sub:z:3","sub:m:task"]);
  expect(families.every(group=>group.children.every(node=>node.parentId===group.parent.id))).toBe(true);
  expect(nodes.map(node=>node.id)).toEqual(original);
});

it("新活动使隐藏任务进入拓扑，全部运行中也不突破五个上限",()=>{
  const children=[...Array(6).keys()].map(i=>({...child("owner",String(i),100-i),activity:"active",status:"running"} satisfies AgentNode));
  const nodes=[parent("owner"),...children];
  expect(topologyFamilies(nodes)[0].children.map(node=>node.id)).toEqual(["sub:owner:0","sub:owner:1","sub:owner:2","sub:owner:3","sub:owner:4"]);
  children[5].lastActiveAt=200;
  expect(topologyFamilies(nodes)[0].children.map(node=>node.id)).toEqual(["sub:owner:5","sub:owner:0","sub:owner:1","sub:owner:2","sub:owner:3"]);
});

it("不足五个全部显示，时间相同顺序稳定，独立活跃主会话仍可见",()=>{
  const standalone=parent("empty");
  standalone.activity="recent";standalone.lastActiveAt=20;
  const nodes=[parent("owner"),standalone,child("owner","z",null),child("owner","b",5),child("owner","a",5)];
  expect(topologyFamilies(nodes).map(group=>group.parent.thread)).toEqual(["empty","owner"]);
  expect(topologyFamilies(nodes)[1].children.map(node=>node.id)).toEqual(["sub:owner:a","sub:owner:b","sub:owner:z"]);
  nodes.push(child("owner","recent",30));
  expect(topologyFamilies(nodes)[0].children[0].id).toBe("sub:owner:recent");
  expect(topologyFamilies([standalone]).map(group=>group.parent.id)).toEqual(["thread:empty"]);
  expect(topologyFamilies([])).toEqual([]);
});

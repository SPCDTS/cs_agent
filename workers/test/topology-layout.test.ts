import { expect, it } from "vitest";
import { topologyPages } from "../browser/topology-layout";
import type { AgentNode } from "../browser/topology-contracts";

const parent=(thread:string): AgentNode=>({id:"thread:"+thread,thread,kind:"thread",parentId:null,activity:"context",lastActiveAt:null});
const child=(thread:string,actor:string,at:number|null): AgentNode=>({id:"sub:"+thread+":"+actor,thread,kind:"subagent",parentId:"thread:"+thread,actor,activity:"recent",lastActiveAt:at,status:"done",summary:null,description:null});

it("跨父会话按子任务最近活动分组排序，翻页保留顺序",()=>{
  const nodes=[parent("a"),parent("z"),parent("m"),child("a","older",10),child("z","a",20),child("z","z",100),child("z","m",90),child("m","task",80)];
  const pages=topologyPages(nodes,3);
  expect(pages.flatMap(page=>page.flatMap(group=>group.children.map(node=>node.id)))).toEqual(["sub:z:z","sub:z:m","sub:z:a","sub:m:task","sub:a:older"]);
  expect(pages[0]?.[0]?.parent.thread).toBe("z");
  const narrow=topologyPages(nodes,1).flatMap(page=>page.flatMap(group=>group.children.map(node=>node.id)));
  expect(narrow).toEqual(["sub:z:z","sub:z:m","sub:m:task","sub:z:a","sub:a:older"]);
});

it("后面的组不填回前页，旧任务更新后前移，时间相同保持稳定顺序",()=>{
  const nodes=[parent("z"),parent("a"),parent("b"),...["1","2","3","4"].map((id,i)=>child("z",id,100-i)),child("a","task",80),child("b","task",70)];
  expect(topologyPages(nodes,4).flatMap(page=>page.flatMap(group=>group.children.map(node=>node.id)))).toEqual(["sub:z:1","sub:z:2","sub:z:3","sub:z:4","sub:a:task","sub:b:task"]);
  nodes.push(child("a","recent",200));
  expect(topologyPages(nodes,4)[0]?.[0]?.children[0]?.id).toBe("sub:a:recent");
  const tied=[parent("owner"),child("owner","z",null),child("owner","b",5),child("owner","a",5)];
  expect(topologyPages(tied,0).flatMap(page=>page.flatMap(group=>group.children.map(node=>node.id)))).toEqual(["sub:owner:a","sub:owner:b","sub:owner:z"]);
});

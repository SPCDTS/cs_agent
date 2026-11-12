import { expect, it } from "vitest";
import { chatChildren } from "../browser/chat-navigation-layout";

const day=24*60*60*1000,now=10*day;
const child=(id:string,lastActiveAt:number,status="done")=>({id,lastActiveAt,status});

it("默认仅展示最近一天内最新的五个已结束子任务，老任务等待展开",()=>{
  const items=[child("old",now-day-1),...[...Array(7).keys()].map(i=>child("recent-"+i,now-i))];
  const view=chatChildren(items,now,undefined,false);
  expect(view.items.map(item=>item.id)).toEqual(["recent-0","recent-1","recent-2","recent-3","recent-4"]);
  expect(view.hidden).toBe(3);
  expect(chatChildren([child("boundary",now-day)],now,undefined,false).items).toHaveLength(1);
  expect(chatChildren([child("old",now-day-1)],now,undefined,false)).toEqual({items:[],hidden:1});
});

it("长期运行和当前选中的旧任务始终可见，新活动重新进入默认列表",()=>{
  const items=[child("running",now-2*day,"running"),child("selected",now-3*day),child("old",now-4*day)];
  expect(chatChildren(items,now,"selected",false).items.map(item=>item.id)).toEqual(["running","selected"]);
  expect(chatChildren(items,now,undefined,false).items.map(item=>item.id)).toEqual(["running"]);
  items[2].lastActiveAt=now;
  expect(chatChildren(items,now,undefined,false).items.map(item=>item.id)).toEqual(["old","running"]);
});

it("展开保留全部任务和稳定顺序，收起后恢复限制且不修改原列表",()=>{
  const items=[child("z",now-2*day),child("b",now),child("a",now)];
  const original=items.map(item=>item.id);
  const all=chatChildren(items,now,undefined,true);
  expect(all.items.map(item=>item.id)).toEqual(["a","b","z"]);
  expect(all.hidden).toBe(1);
  expect(chatChildren(items,now,undefined,false).items.map(item=>item.id)).toEqual(["a","b"]);
  expect(items.map(item=>item.id)).toEqual(original);
});

import { env,reset,runInDurableObject } from "cloudflare:test";
import { afterEach,expect,it } from "vitest";
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { MemoryStore } from "../src/memory/store";
import { MemoryManager } from "../src/memory/management";
import { applyExtraction,MemoryExtractor,type ExtractInput } from "../src/memory/extractor";
import { renderMemorySection } from "../src/memory/render";
import { generateProfileProposal } from "../src/maintenance/profile-proposal";
import { runConsolidate } from "../src/maintenance/consolidate";
import { searchMemory } from "../src/memory/tools";
afterEach(()=>reset());
async function use(fn:(store:MemoryStore,state:DurableObjectState)=>Promise<void>){
 const stub=env.THREAD.getByName("owner");await stub.stats();
 return runInDurableObject(stub,(_instance,state)=>fn(new MemoryStore(new DurableObjectSqliteDatabase(state.storage),"owner",()=>2000000000),state));
}
const source:ExtractInput={text:"主人明确喜欢新咖啡，不再用旧咖啡。",nickname:"合成用户",user_id:"10000001",received_at:1900000000,platform_message_id:"s1",chat_kind:"private",chat_id:"10000001"};
it("去重保留不同对象、事件日期与承诺日期，整理不会误合并",()=>use(async(s,state)=>{
 for(const subject of ["qq:1","qq:2"])await s.remember({kind:"preference",text:"喜欢咖啡",subject,author:"dashboard"});
 for(const since of [100,200])await s.remember({kind:"episode",text:"参加比赛",since,author:"dashboard"});
 for(const due_at of [100,200])await s.remember({kind:"commitment",text:"提交报告",due_at,author:"dashboard"});
 const report=await runConsolidate({store:s,db:s.db,kv:state.storage,complete:async()=>({text:"[]"}),now:2000000000000,config:{rawDays:30,rawHardMaxDays:90,summaryDays:365,eventsDays:30}});
 expect(report).toMatchObject({dedup:0});expect((await s.db.all("SELECT * FROM memories")).length).toBe(6);
}));
it("默认召回排除过期及未来条目，历史查询可访问，空画像仍提示承诺",()=>use(async s=>{
 await s.remember({kind:"fact",text:"旧设置",until:1999999999,author:"dashboard"});
 await s.remember({kind:"fact",text:"未来设置",since:2000000001,author:"dashboard"});
 await s.remember({kind:"commitment",text:"待交报告",author:"dashboard"});
 expect((await s.search({})).map(r=>r.text)).toEqual(["待交报告"]);
 expect(await s.search({history:true})).toHaveLength(3);
 await s.remember({kind:"episode",text:"已结束的比赛",since:100,until:200,author:"dashboard"});
 expect((await s.search({query:"比赛"}))[0].text).toBe("已结束的比赛");
 expect((await s.remember({kind:"fact",text:"旧设置",author:"dashboard"})).duplicate).toBe(false);expect(await renderMemorySection(s)).toContain("待交报告");
 const manager=new MemoryManager(s,()=>2000000000);
 expect((await manager.list({query:"#1"})).items[0].text).toBe("旧设置");
 expect((await manager.list({validity:"future"})).items[0].text).toBe("未来设置");
}));
it("遗忘后暂停画像并抑制自动重新写入，显式重新记住可恢复",()=>use(async s=>{
 const row=(await s.remember({kind:"preference",text:"喜欢咖啡",subject:"self",author:"dashboard"})).row;
 await s.writeProfile("喜欢咖啡","none");const revision=(await s.profile()).revision;
 await s.forget(row.id,"dashboard","不再保留");
 expect((await s.profile()).review).toContain("请复核");expect((await s.profile()).revision).not.toBe(revision);
 expect(await renderMemorySection(s)).toBeUndefined();
 await expect(s.remember({kind:"preference",text:"喜欢咖啡",subject:"self",author:"extractor"})).rejects.toThrow("forgotten_suppressed");
 expect((await s.remember({kind:"preference",text:"喜欢咖啡",subject:"self",author:"dashboard"})).row.status).toBe("active");
}));
it("来源变化后拒绝旧画像建议，手动生成支持少量条目",()=>use(async s=>{
 const row=(await s.remember({kind:"preference",text:"喜欢咖啡",subject:"self",author:"dashboard"})).row;
 const generated=await generateProfileProposal(s,async()=>({text:JSON.stringify({profile:"喜欢咖啡"})}),"manual",true);
 expect(generated.result).toBe("created");
 const m=new MemoryManager(s),p=(await m.proposals())[0];await s.forget(row.id,"dashboard","遗忘");
 await expect(m.decideProposal(p.id,"accepted","none")).rejects.toThrow("conflict");
 expect((await s.profile()).text).toBe("");
}));
it("自动抽取只接受本轮来源和已知目标，显式条目冲突必须确认且受版本保护",()=>use(async s=>{
 const old=(await s.remember({kind:"preference",text:"喜欢旧咖啡",subject:"self",author:"dashboard"})).row;
 const item={kind:"preference" as const,text:"喜欢新咖啡",subject:"self",confidence:0.9,supersedes:old.id,source_message_id:"s1",quote:"喜欢新咖啡"};
 const known=[{id:old.id,version:await s.revision(old.id)}];
 expect(await applyExtraction(s,"turn1",[item],[source],[])).toMatchObject({written:0,dropped:{unknown_target:1}});
 expect(await applyExtraction(s,"turn1",[{...item,source_message_id:"wrong"}],[source],known)).toMatchObject({written:0,dropped:{invalid_source:1}});
 expect(await applyExtraction(s,"turn1",[item],[source],known)).toMatchObject({pending:1,written:0});
 expect((await s.get(old.id))?.status).toBe("active");
 const m=new MemoryManager(s),candidate=(await m.candidates())[0];
 await s.update(old.id,{text:"人工更正后的旧咖啡"},"dashboard");
 await expect(m.decideCandidate(candidate.id,true)).rejects.toThrow("conflict");
 await m.decideCandidate(candidate.id,false);
 const fresh=[{id:old.id,version:await s.revision(old.id)}];await applyExtraction(s,"turn2",[item],[source],fresh);
 await m.decideCandidate((await m.candidates())[0].id,true);
 expect((await s.get(old.id))?.status).toBe("superseded");expect((await s.search({query:"新咖啡"}))[0].author).toBe("dashboard");
 const accepted=(await s.search({query:"新咖啡"}))[0];expect((await m.detail(accepted.id)).evidence[0].quote).toBe("喜欢新咖啡");
}));
it("多消息抽取绑定实际来源，重复确认不会伪增召回次数",()=>use(async s=>{
 const item={kind:"preference" as const,text:"喜欢新咖啡",confidence:1,source_message_id:"s1",quote:"喜欢新咖啡"};
 const sources=[source,{...source,platform_message_id:"s2",text:"另一条无关消息"}];
 await applyExtraction(s,"turn1",[item],sources,[]);await applyExtraction(s,"turn2",[item],sources,[]);
 const row=(await s.search({query:"新咖啡"}))[0];
 expect(row).toMatchObject({source_message_id:"s1",recall_count:0});
 expect((await new MemoryManager(s).detail(row.id)).evidence[0]).toMatchObject({message_id:"s1",quote:"喜欢新咖啡"});
}));
it("编辑与遗忘使用版本校验，同秒修改不能覆盖；完成时间可保存",()=>use(async s=>{
 const m=new MemoryManager(s),row=await m.save(null,{kind:"commitment",text:"交报告",done_at:1900000000});
 expect(row.done_at).toBe(1900000000);const old=await s.revision(row.id);
 await m.save(row.id,{text:"交新报告",kind:"commitment"},old);
 await expect(s.forget(row.id,"dashboard","遗忘",old)).rejects.toThrow("conflict");
 await expect(m.save(row.id,{text:"过期编辑",kind:"fact"},old)).rejects.toThrow("conflict");
}));
it("抽取失败后持久重试，重建对象仍限制为三次且终态不重复执行",()=>use(async s=>{
 let now=1900000000000,calls=0;
 await s.db.run(`INSERT INTO inbound(message_id,platform_message_id,user_id,text,received_at,status,chat_kind,chat_id,nickname,turn_id)
 VALUES ('retry','s1','10000001','这是一条需要记住的长期偏好',1900000000,'done','private','10000001','测试','retry')`);
 const create=()=>new MemoryExtractor(s,async()=>{calls++;throw new Error("synthetic");},()=>true,20000,()=>now);
 const extractor=create();await extractor.enqueue("retry");await extractor.drain();expect(calls).toBe(1);
 expect(await s.db.get("SELECT turn_id FROM extract_queue")).toBeDefined();
 await create().drain();expect(calls).toBe(1);
 now+=60000;await create().drain();now+=60000;await create().drain();
 expect(calls).toBe(3);expect(await s.db.get("SELECT turn_id FROM extract_queue")).toBeUndefined();
 expect(await s.db.get("SELECT status,attempts FROM extract_attempts WHERE turn_id='retry'")).toEqual({status:"failed",attempts:3});
 await create().enqueue("retry");await create().drain();expect(calls).toBe(3);
}));
it("召回优先相关内容，不受历史召回次数支配，完整问句允许标注的关键词降级",()=>use(async s=>{
 const exact=(await s.remember({kind:"rule",text:"回复简短",author:"dashboard"})).row;
 const noisy=(await s.remember({kind:"fact",text:"曾讨论回复简短这个表达的字面含义",author:"extractor"})).row;
 for(let i=0;i<5;i++)await s.touchRecall([noisy.id]);
 expect((await s.search({query:"回复简短"}))[0].id).toBe(exact.id);
 const recalled=await searchMemory(s,{query:"之前回复长度有什么要求"});
 expect(recalled).toContain("关键词相关记忆");expect(recalled).toContain("回复简短");
}));

it("人工确认和修改自动条目后转为显式保护",()=>use(async s=>{
 const first=(await s.remember({kind:"preference",text:"喜欢茶",author:"extractor"})).row;
 const confirmed=await s.remember({kind:"preference",text:"喜欢茶",author:"dashboard"});
 expect(confirmed.duplicate).toBe(true);expect(confirmed.row.author).toBe("dashboard");
 const second=(await s.remember({kind:"preference",text:"喜欢牛奶",author:"extractor"})).row;
 await s.update(second.id,{text:"喜欢热牛奶"},"qq:10000001");
 for(const id of [first.id,second.id])await expect(s.remember({kind:"preference",text:"自动覆盖",author:"extractor"},{supersedes:id})).rejects.toThrow("explicit_memory_protected");
}));

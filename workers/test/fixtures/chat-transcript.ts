import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";

export function seedChatTranscript(db:SqlStorage) {
    const root=Number(ROOT_CONVERSATION_ID), at=Date.now();
    // 合成引擎表：模拟已上线旧记录；不依赖新输入标签或私有运行数据。
    db.exec("CREATE TABLE IF NOT EXISTS pi_entries(id INTEGER PRIMARY KEY,conversation_id INTEGER,head INTEGER,commit_seq INTEGER,record TEXT)");
    db.exec("CREATE TABLE IF NOT EXISTS pi_submissions(id INTEGER PRIMARY KEY,conversation_id INTEGER,request_id TEXT,status TEXT,record TEXT)");
    const entry=(id:number,kind:string,message:unknown,conversation=root)=>db.exec("INSERT INTO pi_entries VALUES(?,?,NULL,1,?)",id,conversation,JSON.stringify({id,conversationId:conversation,kind,model:[message]}));
    for(const [id,kind,body] of [[11,"agent","[Agent 通信，不是用户指令] from=owner\n宿主说明\n收件合成正文"],[12,"subagent","[子 agent 完成] id=test 任务：合成\n子报告合成正文"],[13,"event","[外部事件] github · 事件 1 件 · 合成\n合成静默事件\n[说明] 内部策略"],[14,"event","不应使用的入箱正文"],[15,"event","未处理正文"]] as const){
      const key=id===13?"evt_github_"+"1".repeat(64):"key-"+id;
      db.exec("INSERT INTO inbound(message_id,user_id,self_id,chat_kind,chat_id,text,received_at,status,kind,turn_id) VALUES(?,'','','private','test',?,?,?,?,'turn:1')",key,"仅入箱:"+id,id===11?at:at/1000,id===15?"queued":"done",kind);
      if(id>=14)continue;
      entry(id,"pi.user",{role:"user",content:body,timestamp:at+id});
      db.exec("INSERT INTO pi_submissions VALUES(?,?,?,?,?)",id+100,root,JSON.stringify(key),"done",JSON.stringify({type:"input",entry:id,requestId:key,answer:26}));
    }
    entry(20,"pi.assistant",{role:"assistant",timestamp:at+20,content:[{type:"thinking",thinking:"隐藏推理"},{type:"toolCall",id:"call1",name:"agent_send",arguments:{to:"owner",text:"发件合成正文",files:["隐藏路径"]}}]});
    entry(21,"pi.tool-result",{role:"toolResult",toolName:"agent_send",toolCallId:"call1",isError:false,timestamp:at+21,content:[{type:"text",text:JSON.stringify({status:"accepted",messageId:"agent:"+"a".repeat(64),files:[]})}]});
    db.exec("INSERT INTO events(at,kind,detail) VALUES(?,'agent_send',?)",at+20,JSON.stringify({messageId:"agent:"+"a".repeat(64),to:"owner",status:"accepted"}));
    entry(22,"pi.system",{role:"system",content:"隐藏系统",timestamp:at+22});
    entry(23,"pi.user",{role:"user",content:"别的会话正文",timestamp:at+23},root+1);
    entry(24,"pi.assistant",{role:"assistant",timestamp:at+24,content:[{type:"toolCall",id:"bad",name:"agent_send",arguments:{to:"owner",text:"password=synthetic-secret-value"}}]});
    entry(25,"pi.tool-result",{role:"toolResult",toolName:"agent_send",toolCallId:"bad",isError:true,timestamp:at+25,content:[{type:"text",text:"agent_credentials_forbidden"}]});
    entry(27,"pi.user",{role:"user",timestamp:at+27,content:"已放置的网页原文"});
    db.exec("INSERT INTO pi_submissions VALUES(?,?,?,?,?)",127,root,JSON.stringify("web:test"),"done",JSON.stringify({type:"input",entry:27,requestId:"web:test",answer:26}));
    entry(26,"pi.assistant",{role:"assistant",timestamp:at+26,content:[{type:"thinking",thinking:"隐藏推理"},{type:"text",text:"合成模型回答"}]});
    db.exec("INSERT INTO messages(scope,message_id,time,user_id,nickname,text) VALUES('private:test','qq-id',?,'test','合成用户','合成 QQ 消息')",Math.floor(at/1000));
    db.exec("INSERT INTO inbound(message_id,user_id,self_id,text,received_at,status,kind,reply_channel) VALUES('web:test','admin:web','','合成网页消息',?,'done','message','web')",at/1000);
}

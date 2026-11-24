import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { assertNoCredentials, SESSION_PATTERN } from "../communication/model";
import { sha256Hex } from "../shared/hash";
import type { ProjectionStore } from "./projection";

export type ChatRow = { id:string; role:"user"|"assistant"; source:string; name:string; text:string; at:number; status:string|null; turnId:string|null; assets_json:string };
type Delta = {after:number;pending:string[]};
const root = Number(ROOT_CONVERSATION_ID), address = new RegExp(SESSION_PATTERN);
const hidden = "[内容已隐藏]";
export function safeChatText(text: string, limit=4000):string {
  try { assertNoCredentials(text); } catch { return hidden; }
  return text.slice(0,limit);
}
function inputCard(kind:string, body:string|null, sender:string|null) {
  const name = kind==="agent" && sender && address.test(sender) ? sender : kind==="agent"?"Agent":kind==="subagent"?"子 agent":"事件来源";
  let source=kind==="agent"?"agent-in":kind;
  if(body===null)return {name,source,text:hidden};
  let text=body;
  // 只去宿主协议外壳，不按普通用户正文中的标签推断身份。
  if(kind==="agent")text=body.split("\n").slice(2).join("\n").split("\n已复制到本工作区：\n")[0]??"";
  if(kind==="event"){
    if(body.startsWith("[外部事件] github ·"))source="github";
    else if(body.startsWith("[外部事件] gmail ·"))source="gmail";
    const end=body.lastIndexOf("\n[说明]");
    text=end<0?"外部事件已进入模型":body.slice(0,end);
  }
  return {name,source,text:safeChatText(text)||"（无文本）"};
}
// 单条过大时整段省略，而非先截断再检测凭据；不把 base64、工具诊断或模型原始记录带出 SQL。
const bounded=(expr:string)=>`CASE WHEN typeof(${expr})='text' AND length(${expr})<=24000 THEN ${expr} END`;
export async function transcriptChat(db:ProjectionStore["db"],delta?:Delta):Promise<ChatRow[]> {
  const ready=(await db.get<{n:number}>("SELECT count(*) n FROM sqlite_master WHERE name IN ('pi_entries','pi_submissions')"))?.n===2;
  // 首次运行或滚动升级期间，展示库可能还没收到 Pi schema。只显示队列状态。
  const empty=ready?"":"WITH pi_submissions(input_key,conversation_id,entry_id) AS (SELECT NULL,NULL,NULL WHERE 0), pi_entries(id,conversation_id,record) AS (SELECT NULL,NULL,NULL WHERE 0)";
  const output:ChatRow[]=[];
  // 宿主生成的 requestId 命名空间不从正文读取；inbound 有保留期，不能成为
  // 已入模记录是否存在的依据。旧回合失去关联时不猜 turnId 或处理终态。
  const legacy=`CASE WHEN s.input_key GLOB 'agent:*' THEN 'agent'
    WHEN s.input_key GLOB 'subagent-report:*' THEN 'subagent'
    WHEN s.input_key GLOB 'evt_*' THEN 'event' WHEN s.input_key GLOB 'web:*' THEN 'web' END`;
  const kind=`CASE WHEN i.kind='message' AND i.reply_channel='web' THEN 'web' ELSE COALESCE(i.kind,${legacy}) END`;
  const inputs=await db.all<{key:string;kind:string;sender:string|null;body:string|null;placed:number;at:number;status:string|null;turnId:string|null}>(`
    ${empty} SELECT * FROM (
      SELECT s.input_key key,${kind} kind,i.agent_from sender,i.turn_id turnId,
        1 placed,i.status,${bounded("json_extract(e.record,'$.model[0].content')")} body,
        json_extract(e.record,'$.model[0].timestamp') at
      FROM pi_entries e JOIN pi_submissions s ON s.conversation_id=e.conversation_id AND s.entry_id=e.id
      LEFT JOIN inbound i ON i.message_id=s.input_key
      WHERE e.conversation_id=? AND json_extract(e.record,'$.kind')='pi.user' AND json_extract(e.record,'$.model[0].role')='user'
        AND ${kind} IN ('agent','subagent','event','web')
      UNION ALL
      SELECT i.message_id,i.kind,i.agent_from,i.turn_id,0,i.status,NULL,
        CASE WHEN i.received_at<1e12 THEN i.received_at*1000 ELSE i.received_at END
      FROM inbound i WHERE i.kind IN ('agent','subagent','event') AND i.status IN ('queued','failed')
        AND NOT EXISTS(SELECT 1 FROM pi_submissions s JOIN pi_entries e ON s.conversation_id=e.conversation_id AND s.entry_id=e.id
          WHERE s.input_key=i.message_id AND e.conversation_id=? AND json_extract(e.record,'$.kind')='pi.user'))
    ORDER BY at DESC,key DESC LIMIT 100`,root,root);
  const pending=new Set(delta?.pending);
  for(const row of inputs){
    const id=row.kind==="web"?row.key:"internal:"+sha256Hex(row.key);
    if(delta && row.at<delta.after && !pending.has(id))continue;
    const card=row.kind==="web"?{name:"网页管理员",source:"web",text:row.body===null?hidden:safeChatText(row.body,16000)}:inputCard(row.kind,row.body,row.sender);
    output.push({...card,id,role:"user",at:row.at,status:row.placed?row.status:row.status==="failed"?"failed":"waiting",
      text:row.placed?card.text:"尚无入模记录",turnId:row.turnId,assets_json:"[]"});
  }
  // 宿主直送（例如子任务追问）可能没有 agent_send 工具结果。审计只作投递凭证，
  // 不是入模正文；有同 messageId 的 transcript 时由后者补充，不重复显示。
  const sent=new Map<string,ChatRow>();
  const audits=await db.all<{mid:string;at:number;recipient:string;status:string}>(`
    SELECT json_extract(detail,'$.messageId') mid,at,json_extract(detail,'$.to') recipient,json_extract(detail,'$.status') status
    FROM events WHERE kind='agent_send' ${delta?"AND at>=?":""} ORDER BY at DESC,rowid DESC LIMIT 100`,...(delta?[delta.after]:[]));
  for(const a of audits){
    if(!/^agent:[a-f0-9]{64}$/.test(a.mid)||!address.test(a.recipient)||!["accepted","duplicate"].includes(a.status))continue;
    const id="sent:"+a.mid;
    if(!sent.has(id))sent.set(id,{id,role:"assistant",source:"agent-out",name:"→ "+a.recipient,text:"投递回执（无对话正文）",
      at:a.at,status:a.status,turnId:null,assets_json:"[]"});
  }
  if(!ready)return [...output,...sent.values()];
  // 只配对本 root 中 toolResult 对应的那一次 assistant toolCall。多工具续轮可共用
  // 助手条目，因此还必须匹配 toolCallId；不把工具调用本身当作成功入箱。
  const sends=await db.all<{id:string;at:number;turnId:string|null;recipient:string|null;body:string|null;error:number;unknown:number;receiptId:string|null;receipt:string|null}>(`
    WITH hits AS MATERIALIZED (SELECT e.id entry_id,'agent-out:'||CAST(e.id AS INTEGER) id,
        json_extract(e.record,'$.model[0].timestamp') at,json_extract(e.record,'$.model[0].toolCallId') call_id,
        json_extract(e.record,'$.model[0].isError') error,json_extract(e.record,'$.model[0].content[0].text') result
      FROM pi_entries e WHERE e.conversation_id=? AND json_extract(e.record,'$.model[0].toolName')='agent_send'
        AND json_extract(e.record,'$.kind')='pi.tool-result' AND json_extract(e.record,'$.model[0].role')='toolResult'
        ${delta?"AND json_extract(e.record,'$.model[0].timestamp')>=?":""}
      ORDER BY json_extract(e.record,'$.model[0].timestamp') DESC,e.id DESC LIMIT 100)
    SELECT h.id,h.at,h.error,h.result='agent_delivery_unknown' AS unknown,CASE WHEN json_valid(h.result) THEN json_extract(h.result,'$.messageId') END receiptId,CASE WHEN json_valid(h.result) THEN json_extract(h.result,'$.status') END receipt,
      json_extract(b.value,'$.arguments.to') recipient,${bounded("json_extract(b.value,'$.arguments.text')")} body,
      (SELECT i.turn_id FROM pi_submissions s JOIN inbound i ON i.message_id=s.input_key
        WHERE s.conversation_id=? AND s.entry_id<h.entry_id ORDER BY s.entry_id DESC LIMIT 1) turnId
    FROM hits h LEFT JOIN pi_entries a ON a.id=(SELECT p.id FROM pi_entries p WHERE p.conversation_id=?
      AND json_extract(p.record,'$.kind')='pi.assistant' AND p.id<h.entry_id ORDER BY p.id DESC LIMIT 1)
    LEFT JOIN json_each(a.record,'$.model[0].content') b ON json_extract(b.value,'$.type')='toolCall'
      AND json_extract(b.value,'$.name')='agent_send' AND json_extract(b.value,'$.id')=h.call_id`,root,...(delta?[delta.after]:[]),root,root);
  const seen=new Set<string>();
  for(const row of sends.sort((a,b)=>b.at-a.at || (a.id<b.id?1:-1))){
    const confirmed=!row.error && /^agent:[a-f0-9]{64}$/.test(row.receiptId??"") && (row.receipt==="accepted"||row.receipt==="duplicate");
    const id=confirmed?"sent:"+row.receiptId:row.id;
    if(seen.has(id))continue;
    seen.add(id);
    sent.set(id,{id,role:"assistant",source:"agent-out",name:row.recipient&&address.test(row.recipient)?"→ "+row.recipient:"Agent",
      text:row.unknown?"投递结果未确认":row.error?"调用失败":row.body===null?"（无可展示正文）":safeChatText(row.body),at:row.at,
      status:row.unknown?"unconfirmed":row.error?"failed":confirmed?row.receipt:"unconfirmed",turnId:row.turnId,assets_json:"[]"});
  }
  output.push(...sent.values());
  // 只展示具有宿主输入身份的已结算回答。插话的多个 submission 可共用同一
  // answer entry；按 entry 去重。模型文字不是平台送达凭证。
  const answers=await db.all<{id:string;at:number;body:string|null;turnId:string|null}>(`
    SELECT 'answer:'||CAST(e.id AS INTEGER) id,json_extract(e.record,'$.model[0].timestamp') at,
      (SELECT ${bounded("group_concat(json_extract(b.value,'$.text'),char(10))")} FROM json_each(e.record,'$.model[0].content') b
        WHERE json_extract(b.value,'$.type')='text') body,
      (SELECT i.turn_id FROM pi_submissions s JOIN inbound i ON i.message_id=s.input_key
        WHERE s.conversation_id=e.conversation_id AND s.answer_id=e.id AND i.kind IN ('message','agent','subagent','event')
        ORDER BY s.entry_id DESC LIMIT 1) turnId
      FROM pi_entries e WHERE e.conversation_id=? AND json_extract(e.record,'$.kind')='pi.assistant'
      AND json_extract(e.record,'$.model[0].role')='assistant' AND body IS NOT NULL AND EXISTS(SELECT 1 FROM pi_submissions s LEFT JOIN inbound i ON i.message_id=s.input_key
        WHERE s.conversation_id=e.conversation_id AND s.answer_id=e.id AND (i.kind IN ('message','agent','subagent','event')
        OR (i.message_id IS NULL AND (${legacy} IS NOT NULL OR s.input_key GLOB 'web:*' OR s.input_key GLOB '*:private:*' OR s.input_key GLOB '*:group:*'))))
      ${delta?"AND at>=?":""} ORDER BY at DESC,e.id DESC LIMIT 100`,root,...(delta?[delta.after]:[]));
  for(const row of answers)if(row.body?.trim())output.push({id:row.id,at:row.at,text:safeChatText(row.body),role:"assistant",name:"助手",
    source:"model",status:null,assets_json:"[]",turnId:row.turnId});
  return output;
}

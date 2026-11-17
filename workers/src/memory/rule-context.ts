import type { InboundRow } from "../thread/model";
import { isWeb, isWebAdmin } from "../thread/model";
/** 宿主已存储的真实入站与当前代际；绝不从正文、subject 或模型参数推导。 */
export function ruleScopeForInput(ns:string,input:InboundRow|undefined,owners:readonly string[],generation:number):string|undefined {
  if(ns!=="owner" || !input || input.session_generation!==generation || input.chat_kind!=="private" || !owners.includes(input.chat_id))return;
  if(isWeb(input)) { if(!isWebAdmin(input))return; }
  else if(input.kind==="message") {if(input.user_id!==input.chat_id || input.user_id===input.self_id)return;}
  else if(!["schedule","event","subagent"].includes(input.kind))return;
  return "private:"+input.chat_id;
}

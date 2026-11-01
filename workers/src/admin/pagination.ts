import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

// 管理端数据列表与历史记录统一按 10 条分页；拓扑保持响应式分组。
export const ADMIN_PAGE_SIZE = 10;

const CursorSchema=Type.Object({at:Type.Integer({minimum:0,maximum:Number.MAX_SAFE_INTEGER}),id:Type.String({minLength:1,maxLength:1024})},{additionalProperties:false});
export type AdminCursor=Static<typeof CursorSchema>;
export function readAdminCursor(url:URL):AdminCursor|undefined{
  const raw=url.searchParams.get("cursor");if(raw===null)return;
  const value:unknown=JSON.parse(raw);if(!Check(CursorSchema,value))throw new Error("invalid_cursor");return value;
}
export function nextAdminCursor<T>(rows:T[],cursor:(row:T)=>AdminCursor):string|undefined{
  const last=rows[ADMIN_PAGE_SIZE-1];return rows.length>ADMIN_PAGE_SIZE&&last!==undefined?JSON.stringify(cursor(last)):undefined;
}

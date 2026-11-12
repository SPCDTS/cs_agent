const RECENT_WINDOW=24*60*60*1000,PREVIEW_COUNT=5;

export function chatChildren<T extends {id:string;status:string;lastActiveAt:number}>(items:readonly T[],now:number,selected:string|undefined,showAll:boolean){
  const sorted=[...items].sort((a,b)=>b.lastActiveAt-a.lastActiveAt||a.id.localeCompare(b.id));
  const recent=new Set(sorted.filter(child=>child.status!=="running"&&child.lastActiveAt>=now-RECENT_WINDOW).slice(0,PREVIEW_COUNT).map(child=>child.id));
  const preview=sorted.filter(child=>child.status==="running"||child.id===selected||recent.has(child.id));
  return {items:showAll?sorted:preview,hidden:sorted.length-preview.length};
}

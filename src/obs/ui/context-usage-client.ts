/**
 * 上下文监控页的回合预览（/assets/context-usage.js，docs/DASHBOARD.md §5）。面板内容由服务端预渲染为
 * `<div class="cu-pop" hidden>`，这里只切换 hidden / className / aria-expanded，不拼 HTML、不设 style：
 * - 点击 `.cu-group`：同一 `.cu-pane` 的其他 pop 收起、目标 pop 展开，组加 `.is-active`、`aria-expanded=true`；
 * - 再点同一组、点 pop 里的 `.cu-close`、按 Esc：收起，焦点回到对应的组按钮。
 * 无脚本时按钮不起作用，页面下方的明细表仍是完整信息来源。
 */
export const CONTEXT_USAGE_JS = String.raw`
function up(n,cls){while(n&&n!==document){if(n.classList&&n.classList.contains(cls))return n;n=n.parentNode;}return null;}
function groupsFor(id){return Array.from(document.querySelectorAll('.cu-group')).filter(g=>g.getAttribute('aria-controls')===id);}
function mark(g,on){if(on)g.classList.add('is-active');else g.classList.remove('is-active');g.setAttribute('aria-expanded',on?'true':'false');}
/** 收起面板内全部 pop；返回原先展开的那个对应的组（用于还原焦点）。 */
function shut(pane){
  let was=null;
  for(const pop of pane.querySelectorAll('.cu-pop')){
    const gs=groupsFor(pop.id);
    if(!pop.hidden){pop.hidden=true;was=gs.find(g=>g.classList.contains('is-active'))||gs[0]||was;}
    for(const g of gs)mark(g,false);
  }
  return was;
}
function refocus(g){if(g&&typeof g.focus==='function')g.focus();}
function toggle(g){
  const pop=document.getElementById(g.getAttribute('aria-controls')||'');
  if(!pop||!pop.parentNode)return;
  const open=!pop.hidden&&g.classList.contains('is-active');
  shut(pop.parentNode);
  if(open)return;
  pop.hidden=false;mark(g,true);
}
document.addEventListener('click',e=>{
  const close=up(e.target,'cu-close');
  if(close){const pop=up(close,'cu-pop');if(pop&&pop.parentNode)refocus(shut(pop.parentNode));return;}
  const g=up(e.target,'cu-group');
  if(g)toggle(g);
});
document.addEventListener('keydown',e=>{
  if(e.key!=='Escape')return;
  let last=null;
  for(const pane of document.querySelectorAll('.cu-pane')){const g=shut(pane);if(g)last=g;}
  refocus(last);
});
`;

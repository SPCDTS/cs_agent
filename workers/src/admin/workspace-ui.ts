// 由page.ts拼接到已鉴权管理台；下载仅使用现有前端readToken，不把凭据发给模型或放进URL。
export const WORKSPACE_CSS=String.raw`
#workspace-panel{padding:22px}#workspace-panel h2{margin:0 0 8px;font-size:17px}.workspace-controls{display:flex;gap:10px;align-items:end;flex-wrap:wrap;margin:18px 0}.workspace-controls label{display:flex;flex-direction:column;gap:5px}#workspace-panel .workspace-version{overflow-wrap:anywhere;font-size:12px;color:#64767B;margin:10px 0}.workspace-files{max-height:380px;overflow:auto;border:1px solid #E7EDF0;border-radius:7px}.workspace-files td:first-child{overflow-wrap:anywhere}.workspace-files .workspace-path{font-family:Consolas,monospace;font-size:12px}.workspace-files button{white-space:nowrap}#workspace-child-files label{display:flex;gap:9px;align-items:center}.workspace-empty{padding:20px;color:#64767B}
`;
export const WORKSPACE_HTML=String.raw`
<section id="workspace-panel" class="card">
<h2>工作区文件</h2><p class="muted small">查看已保存文件，或选择子任务的改动合并到当前工作区。文件总量最多50MiB，单文件最多10MiB。</p>
<div class="workspace-controls"><label>会话<input id="workspace-thread" type="text" value="owner" autocomplete="off"></label><button id="workspace-load" class="btn">加载文件</button><button id="workspace-stop" class="btn">停止容器，保留文件</button></div>
<p id="workspace-current" class="workspace-version">尚未加载工作区。</p><div id="workspace-files" class="workspace-files"><div class="workspace-empty">点击“加载文件”查看。</div></div>
<div class="workspace-controls"><label>子任务ID<input id="workspace-child" type="text" autocomplete="off"></label><button id="workspace-inspect" class="btn">检查子任务文件</button><button id="workspace-merge" class="btn primary" disabled>合并选中文件</button></div>
<p id="workspace-versions" class="workspace-version"></p><div id="workspace-child-files" class="workspace-files" hidden></div><p id="workspace-state" class="small" role="status"></p>
</section>
`;
/** 在管理台现有api/readToken/describe作用域内拼接；不启动定时器或轮询。 */

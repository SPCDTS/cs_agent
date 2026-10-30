// 只读本地扫描与显式工作集清单，不访问云端，也不自动迁移生成缓存。
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
const FILE_LIMIT = 10 * 1024 * 1024, WORKSPACE_LIMIT = 50 * 1024 * 1024;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const generated = name => /(^|\/)(frames?|node_modules|\.git|\.cache|cache|tmp|temp)(\/|$)/i.test(name) || /(^|\/)frame[_-]?\d+\.(png|jpe?g|webp)$/i.test(name);
export async function inspectWorkspace({ root, selected = [] }) {
  const base = await fs.realpath(root), selection = new Set(selected), files = [];
  async function walk(dir,prefix="") {
    for(const entry of (await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      const relative=prefix+entry.name,absolute=path.join(dir,entry.name),stat=await fs.lstat(absolute);
      if(stat.isSymbolicLink()) { files.push({path:relative,bytes:0,category:"link",selected:selection.has(relative),reason:"不迁移符号链接"}); continue; }
      if(stat.isDirectory()) { await walk(absolute,relative+"/"); continue; }
      if(!stat.isFile()) { files.push({path:relative,bytes:0,category:"special",selected:selection.has(relative),reason:"不迁移特殊文件"}); continue; }
      const category=generated(relative)?"generated-cache":stat.size>FILE_LIMIT?"over-limit":"user-file";
      const item={path:relative,bytes:stat.size,mode:stat.mode&511,category,selected:selection.has(relative)};
      if(category==="user-file" && item.selected) item.sha256=digest(await fs.readFile(absolute));
      files.push(item);
    }
  }
  await walk(base);
  const missing=[...selection].filter(name=>!files.some(file=>file.path===name)), chosen=files.filter(file=>file.selected);
  const totalBytes=chosen.reduce((sum,file)=>sum+file.bytes,0),errors=[];
  for(const name of missing) errors.push({path:name,reason:"选定路径不存在"});
  for(const file of chosen) if(file.category!=="user-file") errors.push({path:file.path,reason:file.category});
  if(totalBytes>WORKSPACE_LIMIT) errors.push({path:".",reason:"工作集超过50MiB",bytes:totalBytes});
  return {schemaVersion:1,dryRun:true,limits:{fileBytes:FILE_LIMIT,workspaceBytes:WORKSPACE_LIMIT},files,selection:{count:chosen.length,totalBytes,acceptable:chosen.length>0&&errors.length===0,errors},
    summary:{files:files.length,totalBytes:files.reduce((sum,file)=>sum+file.bytes,0),generatedCacheBytes:files.filter(file=>file.category==="generated-cache").reduce((sum,file)=>sum+file.bytes,0)}};
}
function args(argv) {const result={};for(let i=0;i<argv.length;i+=2){if(!argv[i]?.startsWith("--")||!argv[i+1])throw new Error("用法：--root 目录 --output 清单.json [--select 相对路径列表.txt]");result[argv[i].slice(2)]=argv[i+1];}return result;}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {const options=args(process.argv.slice(2));if(!options.root||!options.output)throw new Error("必须明确指定--root与--output；默认只生成审阅报告");
    const selected=options.select?(await fs.readFile(options.select,"utf8")).replace(/^\uFEFF/,"").split(/\r?\n/).map(line=>line.trim()).filter(Boolean):[];
    const report=await inspectWorkspace({root:options.root,selected});await fs.writeFile(options.output,Buffer.from(JSON.stringify(report,null,2)+"\n","utf8"));console.info(JSON.stringify({summary:report.summary,selection:report.selection,output:options.output}));
  }catch(error){console.error(error.message);process.exitCode=1;}
}

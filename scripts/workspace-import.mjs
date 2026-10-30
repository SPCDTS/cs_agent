// 只生成可审阅的R2上传与SandboxDO.importSnapshot计划，不发送网络请求、不读写生产。
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { relativePath } from "../workers/sandbox/workspace.mjs";
const digest=bytes=>createHash("sha256").update(bytes).digest("hex");
export async function buildImportPlan({root,report,workspace,expectedRevision}) {
  if(report?.schemaVersion!==1||!report.selection?.acceptable||!Array.isArray(report.files)||typeof workspace!=="string"||!workspace||typeof expectedRevision!=="string")throw new Error("必须提供通过审核的显式工作集、目标workspace和expectedRevision");
  const base=await fs.realpath(root),selected=report.files.filter(file=>file.selected),files=[];
  for(const file of selected) {
    relativePath(file.path);
    if(file.category!=="user-file"||file.bytes>10*1024*1024||!/^[a-f0-9]{64}$/.test(file.sha256))throw new Error("清单包含生成缓存、超限或未校验文件");
    const absolute=path.join(base,file.path),real=await fs.realpath(absolute),relative=path.relative(base,real);
    if(relative.startsWith("..")||path.isAbsolute(relative)||(await fs.lstat(absolute)).isSymbolicLink())throw new Error("文件路径越界或为符号链接");
    const bytes=await fs.readFile(real);if(bytes.length!==file.bytes||digest(bytes)!==file.sha256)throw new Error(`文件自清单生成后发生变化：${file.path}`);
    files.push({path:file.path,bytes:file.bytes,sha256:file.sha256,mime:"application/octet-stream",mode:file.mode});
  }
  const totalBytes=files.reduce((sum,file)=>sum+file.bytes,0);if(!files.length||totalBytes>50*1024*1024)throw new Error("工作集为空或超过50MiB");
  const datasetId=digest(JSON.stringify(files)),sourceWorkspace=`workspace:import:${datasetId}`,prefix=`cs-agent/v1/scopes/${digest(sourceWorkspace)}/workspace/blobs`;
  const directories=[...new Set(files.flatMap(file=>{const parts=file.path.split("/");return parts.slice(0,-1).map((_,index)=>parts.slice(0,index+1).join("/"));}))];
  return {schemaVersion:1,dryRun:true,datasetId,targetWorkspace:workspace,expectedRevision,manifest:{schemaVersion:1,workspace:sourceWorkspace,revision:datasetId,parentRevision:null,files,directories,totalBytes},uploads:files.map(file=>({path:file.path,sha256:file.sha256,bytes:file.bytes,key:`${prefix}/${file.sha256}`}))};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {const options={};for(let i=2;i<process.argv.length;i+=2){if(!process.argv[i]?.startsWith("--")||!process.argv[i+1])throw new Error("参数需要成对提供");options[process.argv[i].slice(2)]=process.argv[i+1];}
    if(!options.root||!options.report||!options.workspace||!options.expected||!options.output)throw new Error("用法：--root 目录 --report 清单.json --workspace 目标 --expected 当前版本 --output 计划.json");
    const report=JSON.parse((await fs.readFile(options.report,"utf8")).replace(/^\uFEFF/,"")),plan=await buildImportPlan({root:options.root,report,workspace:options.workspace,expectedRevision:options.expected});
    await fs.writeFile(options.output,Buffer.from(JSON.stringify(plan,null,2)+"\n","utf8"));console.info(JSON.stringify({dryRun:true,files:plan.manifest.files.length,bytes:plan.manifest.totalBytes,output:options.output}));
  }catch(error){console.error(error.message);process.exitCode=1;}
}

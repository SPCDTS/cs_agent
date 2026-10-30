// 仅生成私有备份、审阅计划和显式dry-run；没有apply模式，不上传工作区素材。
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { inspectWorkspace } from "./workspace-export.mjs";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8");
async function save(root, relative, value) {
  const file = path.resolve(root, relative), rel = path.relative(path.resolve(root), file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("backup_path_denied");
  await fs.mkdir(path.dirname(file), { recursive: true });
  const bytes = typeof value === "string" || value instanceof Uint8Array ? Buffer.from(value, typeof value === "string" ? "utf8" : undefined) : jsonBytes(value);
  await fs.writeFile(file, bytes, { mode: 0o600 });
  return { bytes: bytes.length, sha256: hash(bytes) };
}
async function readJson(file) { return JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/, "")); }
async function tokenFrom(file) {
  const raw = await fs.readFile(file, "utf8"), line = raw.split(/\r?\n/).find(value => /^\s*(?:export\s+)?ADMIN_TOKEN\s*=/.test(value));
  if (!line) throw new Error("admin_token_missing");
  let value = line.slice(line.indexOf("=") + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1,-1);
  if (!value || /[\r\n]/.test(value)) throw new Error("admin_token_invalid");
  return value;
}
function client(origin, token) {
  const base = new URL(origin);
  if (base.origin !== "https://agent.spcdts.dev") throw new Error("migration_origin_denied");
  return async (method, route, body) => {
    if (!route.startsWith("/admin/")) throw new Error("migration_route_denied");
    if (method !== "GET" && !(method === "POST" && body?.dryRun === true && ["/admin/grants/import", "/admin/memory/history/import"].includes(route))) throw new Error("migration_write_denied");
    const response = await fetch(new URL(route, base), { method, redirect: "error", signal: AbortSignal.timeout(30000),
      headers: { Authorization: "Bearer " + token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await response.text(); let value; try { value = raw ? JSON.parse(raw) : null; } catch { value = null; }
    return { status: response.status, value, sha256: hash(raw) };
  };
}
const grantReader = String.raw`
import sqlite3,json,sys
from pathlib import Path
source=Path(sys.argv[1]);db=sqlite3.connect('file:'+(source/'agent.sqlite').as_posix()+'?mode=ro',uri=True)
documents=[];grants=[]
for doc_id,record,retired in db.execute('SELECT id,record,retired_at FROM documents WHERE kind=?',('"cs.grants"',)):
 if retired is not None and (not isinstance(retired,str) or json.loads(retired) is not None):continue
 revision=db.execute('SELECT seq,content FROM document_revisions WHERE document_id=? ORDER BY seq DESC LIMIT 1',(doc_id,)).fetchone()
 if not revision:continue
 content=revision[1]
 if isinstance(content,bytes):content=content.decode('utf-8')
 if isinstance(content,str):content=json.loads(content)
 documents.append({'id':doc_id,'record':json.loads(record),'seq':revision[0],'content':content})
 def walk(value):
  if isinstance(value,dict):
   if all(k in value for k in ['user','caps','targets','granted_by','created_at','updated_at']):grants.append(value)
   else:
    for child in value.values():walk(child)
  elif isinstance(value,list):
   for child in value:walk(child)
 walk(content)
db.close();print(json.dumps({'documents':documents,'grants':grants},ensure_ascii=False))
`;
async function localGrants(source) {
  const child = spawnSync("python", ["-c", grantReader, source], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" }, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  if (child.status !== 0) throw new Error("legacy_grant_read_failed");
  const result = JSON.parse(child.stdout), unique = new Map(result.grants.map(grant => [grant.user, grant]));
  if (unique.size !== result.grants.length) throw new Error("duplicate_legacy_grant");
  return result;
}
async function copyTree(source, backup, relative = "") {
  let count = 0;
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), rel = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error("legacy_skill_link_denied");
    if (entry.isDirectory()) count += await copyTree(from, backup, rel);
    else if (entry.isFile()) { await save(backup, path.join("local-skills-original", rel), await fs.readFile(from)); count++; }
  }
  return count;
}
export function migrateSkillBody(body) {
  const newline = body.includes("\r\n") ? "\r\n" : "\n", original = body.replace(/\r\n/g,"\n");
  if (original.includes("## 云端工作区安装与发布")) return body;
  const changed = original.replace(/\/(?:app\/data|data|root\/\.(?:codex|agents)|opt\/[^\s`"'<>]+?)\/skills(?=\/|[\s`"'<>)]|$)/g, "/work/skills")
    .replace(/^.*(?:docker\s+(?:exec|cp)|npx\s+skills\s+add|install-skill-from-github\.py).*$/gmi,
      "安装与发布：把候选技能完整保存到 /work/skills/<name>/，先调用 skill_inspect，再按检查结果调用 skill_publish；不要写宿主全局目录或操作 Docker。");
  const note = "## 云端工作区安装与发布\n\n本技能运行在 Workers 的受限工作区。搜索与评估方法沿用下文；安装时只把完整技能目录写到 /work/skills/<name>/。不要使用旧 Docker 路径、全局安装目录或容器重启完成发布。\n\n1. 使用 read/write/bash 在当前工作区准备 SKILL.md 与配套文本文件，保留原说明和非 CS2 内容。\n2. 调用 skill_inspect({path:\"/work/skills/<name>\"})，检查文件清单，并取得 workspaceRevision 与 expectedRevision。\n3. 仅主人本人私聊或经过验证的主人网页回合可调用 skill_publish({path:\"/work/skills/<name>\",workspaceRevision,expectedRevision})；版本冲突时重新检查，不覆盖云端后写。\n4. 不把 ADMIN_TOKEN、宿主凭据或管理接口写入模型参数。技能发布不需要容器常驻；大素材与生成帧不随技能上传。\n\n";
  const match = /^---\n[\s\S]*?\n---(?:\n|$)/.exec(changed);
  const result = match ? changed.slice(0,match[0].length) + "\n" + note + changed.slice(match[0].length) : note + changed;
  return result.replace(/\n/g, newline);
}
function classifyWorkspace(report) {
  const groups = new Map();
  for (const file of report.files) {
    const match = /^(.*?)(\d{2,})(\.(?:jpe?g|png|webp))$/i.exec(file.path);
    if (match) { const key = match[1] + "#" + match[3].toLowerCase(); groups.set(key, (groups.get(key) ?? 0) + 1); }
  }
  const files = report.files.map(file => {
    const match = /^(.*?)(\d{2,})(\.(?:jpe?g|png|webp))$/i.exec(file.path);
    const sequence = match && (groups.get(match[1] + "#" + match[3].toLowerCase()) ?? 0) >= 20;
    const media = /\.(?:jpe?g|png|webp|gif|mp4|mkv|webm|mov|wav|mp3)$/i.test(file.path);
    return { ...file, migrationCategory: sequence ? "generated-frame-candidate" : media ? "media-material" : file.category, upload: false };
  });
  const categories = {};
  for (const file of files) { const item = categories[file.migrationCategory] ??= { count: 0, bytes: 0 }; item.count++; item.bytes += file.bytes; }
  return { ...report, files, migrationSummary: { categories, selectedFiles: 0, uploadFiles: 0 } };
}
async function snapshotCloud(request, backup, phase) {
  const catalog = await request("GET", "/admin/skills");
  if (catalog.status !== 200 || !Array.isArray(catalog.value?.skills)) throw new Error("cloud_skills_unavailable");
  const skills = [];
  for (const item of catalog.value.skills) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(item.name)) throw new Error("cloud_skill_name_invalid");
    const response = await request("GET", "/admin/skills/" + encodeURIComponent(item.name));
    if (response.status !== 200 || typeof response.value?.body !== "string") throw new Error("cloud_skill_unavailable");
    await save(backup, phase + "/skills/" + item.name + ".json", response.value); skills.push(response.value);
  }
  const memory = await request("GET", "/admin/memory?ns=owner");
  if (memory.status !== 200) throw new Error("cloud_memory_unavailable");
  await save(backup, phase + "/memory.json", memory.value);
  return { skills, memory, catalogHash: catalog.sha256 };
}
export async function prepareMigration(options) {
  const { source, backup, tokenFile, origin } = options;
  await fs.mkdir(backup, { recursive: true });
  const persona = await fs.readFile(path.join(source,"prompts","agent.md"));
  const personaMeta = await save(backup,"persona-original.md",persona), localSkillFiles = await copyTree(path.join(source,"skills"),backup);
  const legacy = await localGrants(source); await save(backup,"grants-original.private.json",legacy);
  const grants = { datasetId: "legacy-agent-grants-20261030", sourceHash: hash(JSON.stringify(legacy.documents)), schemaVersion: 1, dryRun: true, grants: legacy.grants };
  await save(backup,"grants-dry-run.private.json",grants);
  const history = await readJson(path.join(backup,"memory-history.json"));
  const workspace = classifyWorkspace(await inspectWorkspace({root:path.join(source,"pi-work"),selected:[]}));
  const workspaceMeta = await save(backup,"workspace-all-classification.private.json",workspace);
  const request = client(origin, await tokenFrom(tokenFile)), cloud = await snapshotCloud(request,backup,"cloud-before"), changes=[];
  for (const name of ["install-skill","find-skills"]) {
    const skill = cloud.skills.find(item=>item.name===name); if (!skill) throw new Error("migration_skill_missing");
    const body = migrateSkillBody(skill.body), meta = await save(backup,"skills-prepared/"+name+"/SKILL.md",body);
    await save(backup,"skills-prepared/"+name+"/input.private.json",{name,body,files:skill.files??{}});
    changes.push({name,sourceBodyHash:hash(skill.body),sourceStateHash:hash(JSON.stringify({body:skill.body,files:skill.files??{}})),preparedBodyHash:meta.sha256,bytes:meta.bytes});
  }
  const summary = { persona:personaMeta, localSkillFiles, cloudSkills:cloud.skills.length, cloudSkillsHash:cloud.catalogHash,
    grants:legacy.grants.length, expiredGrants:legacy.grants.filter(grant=>grant.expires_at!==undefined&&grant.expires_at<=Date.now()).length,
    memory:{current:history.memories.length,versions:history.versions.length,links:history.links.length,proposals:history.proposals.length},
    workspace:{files:workspace.files.length,bytes:workspace.summary.totalBytes,uploadFiles:0,sha256:workspaceMeta.sha256,categories:workspace.migrationSummary.categories}, skillChanges:changes.map(item=>({bytes:item.bytes,sourceBodyHash:item.sourceBodyHash,preparedBodyHash:item.preparedBodyHash})) };
  await save(backup,"migration-plan.private.json",{schemaVersion:1,origin,sourceHashes:{persona:personaMeta.sha256,memory:hash(await fs.readFile(path.join(backup,"memory-history.json")))},pending:{persona:true,skills:changes,grants:true,memoryHistory:true,workspaceUpload:false},summary});
  return summary;
}
export async function dryRunMigration(options) {
  if (options.deployed!==true) throw new Error("deployment_confirmation_required");
  const {backup,origin,tokenFile}=options,request=client(origin,await tokenFrom(tokenFile)),plan=await readJson(path.join(backup,"migration-plan.private.json"));
  const cloud=await snapshotCloud(request,backup,"cloud-after-deploy"), checks=[];
  const persona=await request("GET","/admin/persona"),localPersona=await fs.readFile(path.join(backup,"persona-original.md"),"utf8");
  if(persona.status!==200||typeof persona.value?.revision!=="string")throw new Error("persona_api_unavailable");
  const personaSame=persona.value.text===localPersona,personaSafe=!persona.value.text||personaSame;
  await save(backup,"persona-pending-cas.private.json",{text:localPersona,expected:persona.value.revision,apply:false,conflict:!personaSafe,alreadyEqual:personaSame});
  for(const change of plan.pending.skills){
    const current=cloud.skills.find(item=>item.name===change.name),revision=await request("GET","/admin/skills/"+encodeURIComponent(change.name)+"/revision");
    if(!current||revision.status!==200||typeof revision.value?.revision!=="string")throw new Error("skill_revision_unavailable");
    const input=await readJson(path.join(backup,"skills-prepared",change.name,"input.private.json")),conflict=hash(JSON.stringify({body:current.body,files:current.files??{}}))!==change.sourceStateHash;
    await save(backup,"skills-prepared/"+change.name+"/pending-cas.private.json",{markdown:input.body,files:input.files,expected:revision.value.revision,apply:false,conflict});checks.push({conflict,currentHash:hash(current.body),preparedHash:hash(input.body)});
  }
  const grants=await readJson(path.join(backup,"grants-dry-run.private.json"));grants.dryRun=true;
  const history=await readJson(path.join(backup,"memory-history.json"));
  const grantResult=await request("POST","/admin/grants/import",grants),historyResult=await request("POST","/admin/memory/history/import",{data:history,dryRun:true});
  await save(backup,"grant-dry-run-response.private.json",grantResult);await save(backup,"history-dry-run-response.private.json",historyResult);
  const summary={personaConflict:Number(!personaSafe),personaAlreadyEqual:Number(personaSame),skillConflicts:checks.filter(item=>item.conflict).length,skillCount:checks.length,
    grantsStatus:grantResult.status,historyStatus:historyResult.status,grantsResponseHash:grantResult.sha256,historyResponseHash:historyResult.sha256,workspaceUploadFiles:0,
    historyCounts:{memories:historyResult.value?.memories??0,versions:historyResult.value?.versions??0,links:historyResult.value?.links??0,proposals:historyResult.value?.proposals??0,skipped:historyResult.value?.skipped??0},skillHashes:checks.map(({currentHash,preparedHash})=>({currentHash,preparedHash}))};
  await save(backup,"dry-run-summary.private.json",summary);return summary;
}
function argumentsOf(argv){const result={};for(let i=0;i<argv.length;i++){if(argv[i]==="--deployed"){result.deployed=true;continue;}if(!argv[i]?.startsWith("--")||!argv[i+1])throw new Error("invalid_arguments");result[argv[i].slice(2)]=argv[++i];}return result;}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{const args=argumentsOf(process.argv.slice(2)),options={source:args.source,backup:args.backup,tokenFile:args["token-file"],origin:args.origin??"https://agent.spcdts.dev",deployed:args.deployed};
    if(!options.backup||!options.tokenFile||args.mode==="prepare"&&!options.source)throw new Error("required_arguments_missing");
    const result=args.mode==="prepare"?await prepareMigration(options):args.mode==="dry-run"?await dryRunMigration(options):(()=>{throw new Error("mode_denied");})();console.info(JSON.stringify(result));if(args.mode==="dry-run"&&(result.grantsStatus!==200||result.historyStatus!==200||result.personaConflict||result.skillConflicts))process.exitCode=2;
  }catch(error){console.error(JSON.stringify({errorHash:hash(String(error?.message??error))}));process.exitCode=1;}
}

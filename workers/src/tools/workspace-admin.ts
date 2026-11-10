import { copyJson } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { parseSkill, SKILL_LIMITS, type SkillInput } from "../skills";
import { relativeWorkPath, type WorkspaceManifest } from "../sandbox/workspace";
import { workPath } from "../sandbox/client";
export type WorkspaceReadApi = { files(revision?:string):Promise<WorkspaceManifest>; readBlob(path:string,revision?:string):Promise<{bytes:Uint8Array;mime:string;name:string}> };
export type SkillPublishRegistry = { skillRevision(name:string):Promise<string|undefined>; skillPublish(input:SkillInput,expected:string):Promise<unknown> };
export type WorkspaceSkillOptions = {path:string;name?:string;workspaceRevision?:string};
type SkillStage = "workspace_manifest" | "workspace_blob" | "validate_package" | "registry_revision" | "registry_publish";
class WorkspaceSkillFailure extends Error {
  constructor(readonly stage: SkillStage, cause: unknown) {
    super(cause instanceof Error ? cause.message : "workspace_skill_error", { cause });
  }
}
async function step<T>(stage: SkillStage, run: () => T | Promise<T>): Promise<T> {
  try { return await run(); } catch (error) { throw new WorkspaceSkillFailure(stage, error); }
}
async function readSkillPackage(sandbox:WorkspaceReadApi,options:WorkspaceSkillOptions) {
  const directory=relativeWorkPath(workPath(options.path)),prefix=directory+"/",manifest=await step("workspace_manifest",()=>sandbox.files(options.workspaceRevision));
  const selected=manifest.files.filter(file=>file.path.startsWith(prefix));
  if(!selected.some(file=>file.path===prefix+"SKILL.md"))throw new Error("skill_markdown_missing");
  if(selected.length>128)throw new Error("skill_too_many_files");
  let attachmentBytes=0;
  for(const file of selected) {
    if(file.path===prefix+"SKILL.md") {if(file.bytes>SKILL_LIMITS.markdownBytes)throw new Error("skill_too_large");}
    else {if(file.bytes>SKILL_LIMITS.fileBytes)throw new Error("file_too_large");attachmentBytes+=file.bytes;}
  }
  if(attachmentBytes>SKILL_LIMITS.filesBytes)throw new Error("files_too_large");
  const name=options.name??directory.split("/").at(-1)??"",files:Record<string,string>=Object.create(null),decoder=new TextDecoder("utf-8",{fatal:true,ignoreBOM:false});let markdown="";
  for(const file of selected) {
    const blob=await step("workspace_blob",()=>sandbox.readBlob(file.path,manifest.revision));let text:string;
    try{text=decoder.decode(blob.bytes);}catch{throw new Error("skill_binary_file");}
    if(text.includes("\0"))throw new Error("skill_binary_file");
    const relative=file.path.slice(prefix.length);if(relative==="SKILL.md")markdown=text;else files[relative]=text;
  }
  // RPC 不支持 null-prototype 对象；展开保留特殊文件名为自有属性，避免赋值触发原型 setter。
  return {input:await step("validate_package",()=>parseSkill(name,markdown,{...files})),manifest,selected};
}
export async function inspectWorkspaceSkill(sandbox:WorkspaceReadApi,registry:SkillPublishRegistry,options:WorkspaceSkillOptions) {
  const bundle=await readSkillPackage(sandbox,options);
  return {name:bundle.input.name,description:bundle.input.description,workspaceRevision:bundle.manifest.revision,expectedRevision:await step("registry_revision",()=>registry.skillRevision(bundle.input.name))??"absent",files:bundle.selected.map(file=>({path:file.path,bytes:file.bytes,sha256:file.sha256}))};
}
export async function publishWorkspaceSkill(sandbox:WorkspaceReadApi,registry:SkillPublishRegistry,options:WorkspaceSkillOptions&{workspaceRevision:string;expectedRevision:string}):Promise<unknown> {
  if(!options.expectedRevision||!options.workspaceRevision)throw new Error("revision_required");
  const bundle=await readSkillPackage(sandbox,options);return step("registry_publish",()=>registry.skillPublish(bundle.input,options.expectedRevision));
}
export type WorkspaceAdminToolDeps = {
  /** 宿主核验 owner 原始任务授权及父会话续轮；子 agent 本身没有发布工具。 */
  allowed(api:ToolExecutionApi,context:Context):Promise<boolean>;
  sandbox(api:ToolExecutionApi,context:Context):WorkspaceReadApi|Promise<WorkspaceReadApi>;
  registry():SkillPublishRegistry|Promise<SkillPublishRegistry>;
};
const text=(value:unknown,isError=false,structured=false):ToolExecutionResult=>({...isError?{isError}:{},
  ...(!isError&&structured&&typeof value!=="string"?{structuredOutput:copyJson(JSON.parse(JSON.stringify(value)))}:{}),
  output:[{type:"text",text:typeof value==="string"?value:JSON.stringify(value)}]});
const pathParams={path:Type.String({minLength:1,maxLength:1024}),name:Type.Optional(Type.String({pattern:"^[a-z0-9][a-z0-9-]{0,63}$"}))};
export function createWorkspaceAdminExtension(deps:WorkspaceAdminToolDeps) {
  async function boundary(operation:"inspect"|"publish",api:ToolExecutionApi,context:Context,work:(sandbox:WorkspaceReadApi,registry:SkillPublishRegistry)=>Promise<unknown>) {
    if(!await deps.allowed(api,context))return text("skill_publish_denied：需要有效的主人任务授权；子任务汇报续轮沿用原授权，取消或重置后失效。",true);
    try{return text(await work(await deps.sandbox(api,context),await deps.registry()),false,operation==="inspect");}catch(error){
      const cause=error instanceof WorkspaceSkillFailure?error.cause:error;
      if(cause instanceof Error&&/^[a-z_]{1,80}$/.test(cause.message))return text(cause.message,true);
      const errorId=crypto.randomUUID(),stage=error instanceof WorkspaceSkillFailure?error.stage:"tool_setup";
      const errorName=cause instanceof Error&&/^[A-Za-z]{1,60}$/.test(cause.name)?cause.name:"UnknownError";
      // 记录阶段和类型供宿主定位，不写技能正文、附件或异常中的潜在凭据。
      console.error({event:"workspace_skill_failed",operation,errorId,stage,errorName});
      return text({error:"workspace_skill_error",errorId,stage,errorName},true);
    }
  }
  return defineExtension({name:"cs.workspace-admin",tools:[defineTool({name:"skill_inspect",replay:"safe",description:"Inspect a skill directory in this workspace and return its fixed workspaceRevision and Registry expectedRevision. Inspect before skill_publish.",parameters:Type.Object(pathParams,{additionalProperties:false}),structuredOutputSchema:Type.Object({name:Type.String(),description:Type.String(),workspaceRevision:Type.String(),expectedRevision:Type.String(),files:Type.Array(Type.Object({path:Type.String(),bytes:Type.Number(),sha256:Type.String()}))}),execute:(args,api,context)=>boundary("inspect",api,context,(sandbox,registry)=>inspectWorkspaceSkill(sandbox,registry,args))}),defineTool({name:"skill_publish",replay:"unsafe",description:"Publish the inspected skill from the exact workspaceRevision using Registry compare-and-swap. Requires expectedRevision from skill_inspect.",parameters:Type.Object({...pathParams,workspaceRevision:Type.String({minLength:1,maxLength:64}),expectedRevision:Type.String({minLength:1,maxLength:100})},{additionalProperties:false}),execute:(args,api,context)=>boundary("publish",api,context,(sandbox,registry)=>publishWorkspaceSkill(sandbox,registry,args))})].map(tool=>({...tool,callers:["tools"] as const}))});
}

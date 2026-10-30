import type { WorkspaceReadApi } from "../tools/workspace-admin";
import { relativeWorkPath,type WorkspaceCompareResult,type WorkspaceManifest } from "./workspace";
import { workPath } from "./client";
export type WorkspaceAdminSandbox=WorkspaceReadApi&{resetRuntime():Promise<{reset:boolean}>;mergeFrom(input:{sourceName:string;expectedRevision:string;paths:string[];sourceRevision?:string}):Promise<WorkspaceCompareResult>};
export type WorkspaceMergeInput={childId:string;expectedRevision:string;sourceRevision:string;paths:string[]};
export type WorkspaceAdminDeps={
  authorize(operation:"read"|"merge"|"reset",childId?:string):Promise<void>;
  current():WorkspaceAdminSandbox|Promise<WorkspaceAdminSandbox>;
  /** 回调必须核验父Thread、origin和generation后才解析内部sourceName；浏览器不提供DO名称。 */
  child(childId:string):Promise<{sourceName:string;sandbox:WorkspaceReadApi}>;
};
function childId(value:string):string{if(!/^[A-Za-z0-9_-]{1,100}$/.test(value))throw new Error("invalid_child_id");return value;}
export function createWorkspaceAdminApi(deps:WorkspaceAdminDeps){return {
  async list():Promise<WorkspaceManifest>{await deps.authorize("read");return(await deps.current()).files();},
  async download(input:{path:string;revision:string}):Promise<{bytes:Uint8Array;mime:string;name:string}>{await deps.authorize("read");if(!input.revision)throw new Error("revision_required");return(await deps.current()).readBlob(relativeWorkPath(workPath(input.path)),input.revision);},
  async resetRuntime():Promise<{reset:boolean}>{await deps.authorize("reset");return(await deps.current()).resetRuntime();},
  async inspectChild(input:{childId:string}):Promise<{childId:string;parent:WorkspaceManifest;source:WorkspaceManifest}>{const id=childId(input.childId);await deps.authorize("read",id);const child=await deps.child(id);return{childId:id,parent:await(await deps.current()).files(),source:await child.sandbox.files()};},
  async mergeChild(input:WorkspaceMergeInput):Promise<WorkspaceCompareResult>{const id=childId(input.childId);await deps.authorize("merge",id);if(!input.expectedRevision||!input.sourceRevision)throw new Error("revision_required");if(!input.paths.length||input.paths.length>256)throw new Error("invalid_merge_paths");const paths=input.paths.map(path=>relativeWorkPath(workPath(path)));if(new Set(paths).size!==paths.length)throw new Error("invalid_merge_paths");const child=await deps.child(id);return(await deps.current()).mergeFrom({sourceName:child.sourceName,expectedRevision:input.expectedRevision,sourceRevision:input.sourceRevision,paths});},
};}
export type WorkspaceAdminApi=ReturnType<typeof createWorkspaceAdminApi>;

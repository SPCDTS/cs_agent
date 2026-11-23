import type { SandboxClient } from "../src/sandbox/client";
import { sha256 } from "../src/media/model";
export function runtime() {
  let files = new Map<string,Uint8Array>(), directories = new Set<string>(), ready = false, executions = 0, failExec = false;
  const relative = (path: string) => path.replace(/^\/work\//, "");
  const client: SandboxClient = {
    async restore(snapshot, readBlob) { ready = true; directories = new Set(snapshot.directories); files = new Map(await Promise.all(snapshot.files.map(async (file): Promise<[string, Uint8Array]> => [file.path, await readBlob(file)]))); },
    async writeFile(path, text) { const value = typeof text === "string" ? new TextEncoder().encode(text) : text; files.set(relative(path), value); return { bytes: value.length }; },
    async mkdir(path) { directories.add(relative(path)); },
    async remove(path) { const target = relative(path); for (const name of files.keys()) if (name === target || name.startsWith(target + "/")) files.delete(name); for (const name of directories) if (name === target || name.startsWith(target + "/")) directories.delete(name); },
    async readFile(path) { return { text: new TextDecoder().decode(files.get(relative(path))), startLine: 1, endLine: 1, totalLines: 1 }; },
    async exec() { executions++; if (failExec) { failExec = false; throw new Error("sandbox_unavailable"); } files.set("binary.bin", new Uint8Array([0,255,1])); return { stdout: "ok", stderr: "", code: 0, timedOut: false, truncated: false }; },
    async readBlob(path) { const value = files.get(relative(path)); if (!value) throw new Error("not_found"); return value; },
    async snapshot() { const entries = await Promise.all([...files].map(async ([path, bytes]) => ({ path, bytes: bytes.length, sha256: await sha256(bytes), mime: "application/octet-stream", mode: 420 }))); return { files: entries, directories: [...directories], totalBytes: entries.reduce((sum, file) => sum + file.bytes, 0) }; },
    async list() { return []; },
    async editFile() { throw new Error("unused"); },
  };
  return { client, ready:()=>ready, reset:async()=>{ready=false;files=new Map();return true;}, executions:()=>executions, fail:()=>{failExec=true;} };
}

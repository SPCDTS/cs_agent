import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { createSandboxServer } from "../sandbox/server.mjs";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
async function fixture(work) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-workspace-")), root = path.join(base,"work");
  await fs.mkdir(root);
  const server = createSandboxServer({ root });
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, body) => {
    const response = await fetch(origin + route, { method, body: body instanceof Uint8Array ? body : body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try { await work({root,call,origin}); } finally { await new Promise(resolve => server.close(resolve)); assert.equal(path.dirname(root),base); await fs.rm(base,{recursive:true,force:true}); }
}
test("真实控制服务快照与重建恢复二进制及空目录", () => fixture(async ({root,call,origin}) => {
  const bytes = Buffer.from([137,80,78,71,13,10,26,10,0,255,14]);
  await fs.mkdir(path.join(root,"empty")); await fs.writeFile(path.join(root,"image.png"),bytes); await fs.writeFile(path.join(root,"text.txt"),"中文\r\nline");
  const snapshot = await call("GET","/snapshot"); assert.equal(snapshot.status,200); assert.equal(snapshot.body.files.length,2); assert.deepEqual(snapshot.body.directories,["empty"]);
  const file = snapshot.body.files.find(file => file.path === "image.png"); assert.equal(file.sha256,digest(bytes));
  assert.deepEqual((await call("GET","/file?path=image.png")).body,{kind:"image",data:bytes.toString("base64"),mimeType:"image/png"});
  assert.deepEqual(Buffer.from(await (await fetch(origin+"/blob?path=image.png")).arrayBuffer()),bytes);
  const stored = new Map(await Promise.all(snapshot.body.files.map(async file => [file.path,await fs.readFile(path.join(root,file.path))])));
  const start = await call("POST","/restore/start",snapshot.body); assert.equal(start.status,200);
  await fs.writeFile(path.join(root,"later.txt"),"should disappear");
  for (const file of snapshot.body.files) assert.equal((await call("PUT",`/restore/blob?id=${start.body.id}&path=${encodeURIComponent(file.path)}`,stored.get(file.path))).status,200);
  assert.deepEqual((await call("POST","/restore/commit",{id:start.body.id})).body,{restored:true});
  assert.deepEqual(await fs.readFile(path.join(root,"image.png")),bytes); assert.deepEqual(await fs.readdir(root),["empty","image.png","text.txt"]);
}));
test("快照明确拒绝链接、单文件和总量超限，不静默丢文件", () => fixture(async ({root,call}) => {
  await fs.writeFile(path.join(root,"large.bin"),Buffer.alloc(10*1024*1024+1));
  let result = await call("GET","/snapshot"); assert.equal(result.status,400); assert.equal(result.body.error,"workspace_quota"); assert.ok(result.body.issues.some(issue=>issue.path === "large.bin" && issue.code === "file_too_large"));
  await fs.unlink(path.join(root,"large.bin"));
  for(let i=0;i<6;i++) await fs.writeFile(path.join(root,`part${i}`),Buffer.alloc(10*1024*1024));
  result = await call("GET","/snapshot"); assert.equal(result.body.error,"workspace_quota"); assert.ok(result.body.issues.some(issue=>issue.code === "workspace_too_large"));
}));
test("恢复缺少或损坏blob、越界路径时保留原工作集", () => fixture(async ({root,call}) => {
  await fs.writeFile(path.join(root,"keep.txt"),"keep");
  const files=[{path:"new.bin",bytes:2,sha256:digest(Buffer.from([1,2])),mime:"application/octet-stream",mode:420}];
  const start=await call("POST","/restore/start",{files,directories:[],totalBytes:2});
  assert.equal((await call("POST","/restore/commit",{id:start.body.id})).body.error,"restore_incomplete");
  assert.equal((await call("PUT",`/restore/blob?id=${start.body.id}&path=new.bin`,Buffer.from([9,9]))).body.error,"blob_corrupt");
  assert.equal((await call("POST","/restore/start",{files:[{...files[0],path:"../escape"}],directories:[]})).body.error,"path_denied");
  assert.equal(await fs.readFile(path.join(root,"keep.txt"),"utf8"),"keep");
}));

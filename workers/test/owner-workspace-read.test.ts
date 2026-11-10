import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { SandboxDO } from "../src/sandbox/do";
import { sha256 } from "../src/media/model";
import { scopePrefix } from "../src/media/repository";
import { scriptedModel } from "./events-helpers";
import { input } from "./helpers";

afterEach(async () => { vi.restoreAllMocks(); await reset(); });
const groupA = "group:200000001", groupB = "group:200000002";
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
async function seed(workspace: string, label: string) {
  const sandbox = env.SANDBOX.getByName(workspace), current = await sandbox.files();
  const entries = [{ path: "out/report.md", bytes: new TextEncoder().encode("首行\n" + label + "\n末行") }, { path: "out/image.png", bytes: png }];
  const files = await Promise.all(entries.map(async ({ path, bytes }) => {
    const digest = await sha256(bytes);
    await env.ASSETS.put((await scopePrefix(current.workspace)) + "/workspace/blobs/" + digest, bytes);
    return { path, bytes: bytes.length, sha256: digest, mime: path.endsWith("png") ? "image/png" : "text/plain", mode: 420 };
  }));
  const result = await sandbox.importSnapshot({ expectedRevision: current.revision, manifest: { ...current, files, directories: ["out"], totalBytes: files.reduce((sum, file) => sum + file.bytes, 0) } });
  expect(result.ok).toBe(true);
  return (await sandbox.files()).revision;
}

it.each(["qq", "web"] as const)("owner %s 使用原 read 读取多个群的持久文件，保留分段和图片格式且不启动运行时", async channel => {
  const beforeA = await seed(groupA, "甲群内容"), beforeB = await seed(groupB, "乙群内容");
  const run = vi.spyOn(SandboxDO.prototype, "run");
  const seen = scriptedModel([{ name: "codemode", args: { code: [
    'text((await tools.read({workspace:"group:200000001",path:"/work/out/report.md",offset:2,limit:1})).text);',
    'text((await tools.read({workspace:"group:200000002",path:"out/report.md"})).text);',
    'const picture=await tools.read({workspace:"group:200000001",path:"out/image.png"});text(picture);',
    'try { await tools.write({workspace:"group:200000001",path:"out/report.md",content:"禁止改写"}); } catch(error) { text(String(error)); }',
    'try { await tools.read({workspace:"group:200000001",path:"../../outside"}); } catch(error) { text(String(error)); }',
  ].join("\n") } }]);
  const thread = env.THREAD.getByName("owner");
  if (channel === "web") {
    await thread.submitWeb("owner", crypto.randomUUID(), "查看群产物");
    await expect.poll(async () => (await thread.chatView("owner")).active).toBe(0);
  } else await thread.submit(input(1, "查看群产物", 10000001));
  const output = seen.outputs.join("\n");
  expect(output).toContain("甲群内容\n\n[Showing lines 2-2 of 3. Use offset=3 to continue.]");
  expect(output).toContain("乙群内容");
  expect(output).toContain('"kind":"image"');
  expect(output).toContain("iVBORw0KGgoA/w==");
  expect(output).toContain("path_denied");
  expect(run).not.toHaveBeenCalled();
  expect((await env.SANDBOX.getByName(groupA).files()).revision).toBe(beforeA);
  expect((await env.SANDBOX.getByName(groupB).files()).revision).toBe(beforeB);
});

it.each([10000001, 10000004])("群回合中的用户 %s 不获得跨群读取权", async actor => {
  await seed(groupB, "乙群私有内容");
  const read = vi.spyOn(SandboxDO.prototype, "readBlob");
  const seen = scriptedModel([{ name: "codemode", args: { code: 'text(await tools.read({workspace:"group:200000002",path:"out/report.md"}));' } }]);
  await env.THREAD.getByName(groupA).submit(input(1, "跨群查看", actor, 200000001, true));
  expect(seen.outputs.join("\n")).toContain("permission_denied");
  expect(read).not.toHaveBeenCalled();
});

it("owner 任务撤销后下一次跨群读取立即拒绝", async () => {
  await seed(groupA, "授权期间可读");
  const original = SandboxDO.prototype.readBlob;
  const read = vi.spyOn(SandboxDO.prototype, "readBlob").mockImplementationOnce(async function (this: SandboxDO, path, revision) {
    const value = await original.call(this, path, revision);
    await runInDurableObject(env.THREAD.getByName("owner"), (_instance, state) => { state.storage.sql.exec("UPDATE sandbox_tasks SET revoked_at=1"); });
    return value;
  });
  const seen = scriptedModel([{ name: "codemode", args: { code: 'text((await tools.read({workspace:"group:200000001",path:"out/report.md"})).text);text(await tools.read({workspace:"group:200000001",path:"out/report.md"}));' } }]);
  await env.THREAD.getByName("owner").submit(input(1, "查看群产物", 10000001));
  expect(read).toHaveBeenCalledTimes(1);
  expect(seen.outputs.join("\n")).toContain("授权期间可读");
  expect(seen.outputs.join("\n")).toContain("本回合无权使用沙箱工具");
});

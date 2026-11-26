import { env, SELF, reset, runInDurableObject, evictDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import * as models from "../src/models";
import { SandboxDO } from "../src/sandbox/do";
import { RegistryDO } from "../src/registry";
import { MCP_CONFIG } from "../src/mcp/config";
import { MediaRepository, readMediaToken } from "../src/media/repository";
import { WorkspaceManager } from "../src/sandbox/workspace";
import type { SandboxClient } from "../src/sandbox/client";
import { sha256 } from "../src/media/model";
import { scriptedModel } from "./events-helpers";
import { action, adminHealth, connect, event, input, reply, syncedView } from "./helpers";

describe("group messaging", () => {
  const sockets: WebSocket[] = [];
  const group = () => env.THREAD.getByName("group:200000001");
  afterEach(async () => { for (const socket of sockets.splice(0)) socket.close(); await reset(); });
  
  describe("group conversations", () => {
    it("ingests allowed group chatter without starting Pi and persists the cached group name", async () => {
      const { socket, frames } = await connect(sockets);
      socket.send(JSON.stringify(event(1, "普通聊天", 10000004, 200000001)));
      await expect.poll(() => env.BRIDGE.getByName("napcat").status()).toMatchObject({ threads: ["group:200000001"] });
      await group().syncAdminView("group:200000001");
      await expect.poll(() => runInDurableObject(group(), (_instance, state) => state.storage.sql.exec("SELECT text FROM messages").toArray()))
        .toEqual([{ text: "普通聊天" }]);
      expect(await (await syncedView("group:200000001")).stats()).toMatchObject({ inbound: { queued: 0, done: 0, failed: 0 }, outbox: 0 });
      expect(await runInDurableObject(group(), (_instance, state) => state.storage.sql.exec("SELECT scope, name FROM scope_names").toArray()))
        .toEqual([{ scope: "group:200000001", name: "测试群" }]);
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({ action: "get_group_info" });
    });
  
    it("replies to a real group mention with at, records self history, and deduplicates across eviction", async () => {
      const { socket, frames } = await connect(sockets);
      const raw = event(2, "帮忙", 10000004, 200000001, true);
      socket.send(JSON.stringify(raw));
      const frame = await action(frames);
      expect(frame.params).toEqual({ group_id: "200000001", message: [
        { type: "at", data: { qq: "10000004" } }, { type: "text", data: { text: "echo: [@你]帮忙" } },
      ] });
      reply(socket, frame.echo);
      await expect.poll(async () => (await syncedView("group:200000001")).stats()).toMatchObject({ inbound: { done: 1 }, outbox: 1 });
      const rows = await runInDurableObject(group(), (_instance, state) => ({
        messages: state.storage.sql.exec("SELECT scope, message_id, is_self, reply_to_id FROM messages ORDER BY id").toArray(),
        entries: state.storage.sql.exec("SELECT * FROM pi_entries").toArray(),
      }));
      expect(rows.messages).toEqual([
        { scope: "group:200000001", message_id: "2", is_self: 0, reply_to_id: null },
        { scope: "group:200000001", message_id: "90000001", is_self: 1, reply_to_id: "2" },
      ]);
      expect(JSON.stringify(rows.entries)).toContain("本回合的人：群成员 成员10000004(10000004)，会话：群 测试群(200000001)");
      expect(JSON.stringify(rows.entries)).toContain("绝不透露凭据");
      await evictDurableObject(env.BRIDGE.getByName("napcat"));
      await evictDurableObject(group());
      socket.send(JSON.stringify(raw));
      socket.send(JSON.stringify(event(3, "接着聊", 10000004, 200000001)));
      await expect.poll(() => runInDurableObject(group(), (_instance, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages").one().n)).toBe(3);
      expect(frames).toHaveLength(2);
      expect(await group().submit(input(2, "帮忙", 10000004, 200000001, true))).toEqual({ deduped: true });
      expect(await (await adminHealth()).json()).toMatchObject({ threads: ["group:200000001"], sendRules: [], thread: { error: "view_pending" } });
    });
  
    it("ignores disallowed groups and admits allowUsers private messages", async () => {
      const { socket, frames } = await connect(sockets);
      socket.send(JSON.stringify(event(4, "不允许的群", 10000004, 200000002, true)));
      socket.send(JSON.stringify(event(5, "白名单私聊")));
      const frame = await action(frames, 0, "send_private_msg");
      expect(frame.params.user_id).toBe("10000003");
      reply(socket, frame.echo);
      await expect.poll(async () => (await syncedView("private:10000003")).stats()).toMatchObject({ inbound: { done: 1 } });
      expect(await env.BRIDGE.getByName("napcat").status()).toMatchObject({ ignored: 1, threads: ["private:10000003"] });
      expect(frames).toHaveLength(1);
    });
  
    it("queues different senders in arrival order and keeps each turn identity and at target", async () => {
      const { socket, frames } = await connect(sockets);
      const thread = group();
      const first = thread.submit(input(10, "一", 10000004, 200000001, true));
      const one = await action(frames);
      const second = thread.submit(input(11, "二", 10000005, 200000001, true));
      const third = thread.submit(input(12, "三", 10000006, 200000001, true));
      await expect.poll(async () => (await syncedView("group:200000001")).stats()).toMatchObject({ inbound: { queued: 3 } });
      reply(socket, one.echo, 90000010);
      const two = await action(frames, 1);
      expect(two.params.message?.[0]?.data.qq).toBe("10000005");
      reply(socket, two.echo, 90000011);
      const three = await action(frames, 2);
      expect(three.params.message?.[0]?.data.qq).toBe("10000006");
      reply(socket, three.echo, 90000012);
      expect(await Promise.all([first, second, third])).toEqual([{ status: "done" }, { status: "done" }, { status: "done" }]);
      const entries = await runInDurableObject(thread, (_instance, state) => state.storage.sql.exec("SELECT * FROM pi_entries").toArray());
      for (const id of [10000004, 10000005, 10000006]) expect(JSON.stringify(entries)).toContain(`群成员 成员${id}(${id})`);
    });
  
    it("submits same-sender followups with steer while the current tool is waiting", async () => {
      const { socket, frames } = await connect(sockets);
      const thread = group();
      const first = thread.submit(input(20, "一", 10000004, 200000001, true));
      const one = await action(frames);
      const second = thread.submit(input(21, "补充", 10000004, 200000001, true));
      await expect.poll(() => runInDurableObject(thread, (_instance, state) => state.storage.sql.exec("SELECT when_busy FROM inbound WHERE platform_message_id = '21'").toArray()))
        .toEqual([{ when_busy: "steer" }]);
      reply(socket, one.echo, 90000020);
      const two = await action(frames, 1);
      expect(one.params.message?.[0]?.data.qq).toBe("10000004");
      expect(two.params.message?.some(segment => segment.type === "at")).toBe(false);
      reply(socket, two.echo, 90000021);
      expect(await Promise.all([first, second])).toEqual([{ status: "done" }, { status: "done" }]);
      const submissions = await runInDurableObject(thread, (_instance, state) => state.storage.sql.exec<{ answer: number }>("SELECT json_extract(record, '$.answer') AS answer FROM pi_submissions ORDER BY id").toArray());
      // 插话与原输入由同一个最终 answer 结算，确实加入了当前回合。
      expect(submissions).toHaveLength(2);
      expect(submissions[0].answer).toBe(submissions[1].answer);
    });
  
    it("refreshes group names only after the six-hour cache expires", async () => {
      const { socket, frames } = await connect(sockets);
      socket.send(JSON.stringify(event(30, "第一条", 10000004, 200000001)));
      await group().syncAdminView("group:200000001");
      await expect.poll(() => runInDurableObject(group(), (_instance, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages").one().n)).toBe(1);
      const bridge = env.BRIDGE.getByName("napcat");
      const cache = await runInDurableObject(bridge, (_instance, state) => state.storage.get<{ name: string; expires: number }>("group:200000001"));
      expect(cache?.expires).toBeGreaterThan(Date.now() + 5 * 3600_000);
      await runInDurableObject(bridge, (_instance, state) => state.storage.put("group:200000001", { name: "旧名", expires: 0 }));
      socket.send(JSON.stringify(event(31, "第二条", 10000004, 200000001)));
      await action(frames, 1, "get_group_info");
      await expect.poll(() => runInDurableObject(group(), (_instance, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages").one().n)).toBe(2);
      expect(frames).toHaveLength(2);
    });
  
    it("does not let a same-sender followup overtake an already queued member", async () => {
      const { socket, frames } = await connect(sockets);
      const thread = group();
      const first = thread.submit(input(40, "一", 10000004, 200000001, true));
      const one = await action(frames);
      const second = thread.submit(input(41, "二", 10000005, 200000001, true));
      const third = thread.submit(input(42, "三", 10000004, 200000001, true));
      await expect.poll(() => runInDurableObject(thread, (_instance, state) => state.storage.sql.exec("SELECT when_busy FROM inbound WHERE platform_message_id = '42'").toArray()))
        .toEqual([{ when_busy: "followUp" }]);
      reply(socket, one.echo, 90000040);
      const two = await action(frames, 1);
      expect(two.params.message?.[0]?.data.qq).toBe("10000005");
      reply(socket, two.echo, 90000041);
      const three = await action(frames, 2);
      expect(three.params.message?.[0]?.data.qq).toBe("10000004");
      reply(socket, three.echo, 90000042);
      expect(await Promise.all([first, second, third])).toEqual([{ status: "done" }, { status: "done" }, { status: "done" }]);
    });
  
    it("bounds bridge deduplication to 5000 and health thread listings to 50", async () => {
      const { socket } = await connect(sockets);
      const bridge = env.BRIDGE.getByName("napcat");
      await runInDurableObject(bridge, (_instance, state) => {
        state.storage.transactionSync(() => {
          for (let i = 0; i < 5000; i++) state.storage.sql.exec("INSERT INTO seen(key) VALUES (?)", `old:${i}`);
          for (let i = 0; i < 60; i++) state.storage.sql.exec("INSERT INTO threads(key, seen_at) VALUES (?, ?)", `group:${200000010 + i}`, i);
        });
      });
      socket.send(JSON.stringify(event(50, "新的上下文", 10000004, 200000001)));
      await expect.poll(() => bridge.status()).toMatchObject({ threads: expect.arrayContaining(["group:200000001"]) });
      expect((await bridge.status()).threads).toHaveLength(50);
      expect(await runInDurableObject(bridge, (_instance, state) => ({
        count: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM seen").one().n,
        oldest: state.storage.sql.exec<{ key: string }>("SELECT key FROM seen ORDER BY id LIMIT 1").one().key,
      }))).toEqual({ count: 5000, oldest: "old:1" });
      await group().syncAdminView("group:200000001");
      await expect.poll(() => runInDurableObject(group(), (_instance, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages").one().n)).toBe(1);
    });
  });
});

describe("group coding", () => {
  const sockets: WebSocket[] = [];
  afterEach(async () => { for (const socket of sockets.splice(0)) socket.close(); vi.restoreAllMocks(); await reset(); });
  const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1sAAAAASUVORK5CYII=";
  const png = Uint8Array.from(atob(data), c => c.charCodeAt(0));
  const group = "group:200000001";
  const source = 'import { mkdir, writeFile } from "node:fs/promises"; const r = await fetch("https://shop.example.com/jersey.png"); if (!r.ok) throw Error(String(r.status)); await mkdir("out", {recursive:true}); await writeFile("out/jersey.png", new Uint8Array(await r.arrayBuffer()));';
  const script = `text(await tools.write({path:"download.mjs",content:${JSON.stringify(source)}})); text(await tools.bash({command:"node download.mjs"})); const result=await tools.read({path:"out/jersey.png"}); image(result.image);`;
  
  // 仅替代容器边界；Thread、Code Mode、持久化、资产导出和 QQ 发送均走真实实现。
  // 实际脚本联网下载另由 sandbox-server.node.mjs 验证。
  async function installRuntime(scope: string) {
    await runInDurableObject(env.SANDBOX.getByName(scope), (instance, state) => {
      let files = new Map<string, Uint8Array>(), directories = new Set(["out"]), ready = false;
      const relative = (path: string) => path.replace(/^\/work\//, "");
      const client: SandboxClient = {
        async restore(snapshot, read) { files = new Map(await Promise.all(snapshot.files.map(async f => [f.path, await read(f)] as const))); directories = new Set(snapshot.directories); ready = true; },
        async writeFile(path, text) { const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text; files.set(relative(path), bytes); return { bytes: bytes.length }; },
        async mkdir(path) { directories.add(relative(path)); },
        async remove() { throw Error("unused"); },
        async exec(command) {
          expect(command).toBe("node download.mjs");
          expect(new TextDecoder().decode(files.get("download.mjs"))).toBe(source);
          files.set("out/jersey.png", png);
          return { stdout: "downloaded", stderr: "", code: 0, timedOut: false, truncated: false };
        },
        async readFile(path) { if (!files.has(relative(path))) throw Error("not_found"); return { kind: "image", data, mimeType: "image/png" }; },
        async readBlob(path) { const bytes = files.get(relative(path)); if (!bytes) throw Error("not_found"); return bytes; },
        async snapshot() {
          const entries = await Promise.all([...files].map(async ([path, bytes]) => ({ path, bytes: bytes.length, sha256: await sha256(bytes), mime: path.endsWith(".png") ? "image/png" : "text/javascript", mode: 420 })));
          return { files: entries, directories: [...directories], totalBytes: entries.reduce((n, f) => n + f.bytes, 0) };
        },
        async list() { return []; },
        async editFile() { throw Error("unused"); },
      };
      Object.defineProperty(instance, "workspace", { value: new WorkspaceManager({
        workspace: "workspace:" + state.id.toString(), storage: state.storage, bucket: env.ASSETS, runtime: client,
        runtimeReady: () => ready, resetRuntime: async () => { ready = false; files.clear(); },
      }) });
    });
  }
  function inspectThenSend() {
    const faux = fauxProvider({ models: [{ id: "test", input: ["text", "image"] }], tokensPerSecond: Infinity });
    const images: string[] = [], saved: string[] = [];
    let step = 0;
    const respond: FauxResponseFactory = transcript => {
      faux.setResponses([respond]);
      for (const message of transcript.messages) if (message.role === "toolResult") for (const block of message.content) if (block.type === "image") images.push(block.data);
      if (step++ === 0) return fauxAssistantMessage(fauxToolCall("codemode", { code: script }), { stopReason: "toolUse" });
      if (step === 2) {
        const output = transcript.messages.flatMap(message => message.role === "toolResult" ? message.content.filter(block => block.type === "text").map(block => block.text) : []).join("\n");
        const path = /Image saved to (r2:\/\/[^\s]+\.png)/.exec(output)?.[1];
        expect(path, output).toBeDefined();
        if (!path) throw Error("image_not_saved");
        saved.push(path);
        return fauxAssistantMessage(fauxToolCall("send_file", { path, name: "队服.png" }), { stopReason: "toolUse" });
      }
      return fauxAssistantMessage("done");
    };
    faux.setResponses([respond]);
    vi.spyOn(models, "openModels").mockImplementation(() => { const registry = createModels(); registry.setProvider(faux.provider); return registry; });
    return { images, saved };
  }
  
  describe("群聊通用脚本与产物发送", () => {
    it("无 MCP 授权的群成员可写脚本、执行、查看并在原群发送已提交图片", async () => {
      vi.spyOn(RegistryDO.prototype, "mcpConfig").mockReturnValue({ ...MCP_CONFIG, enabled: false, servers: [] });
      await installRuntime(group);
      const seen = inspectThenSend(), { socket, frames } = await connect(sockets);
      const run = env.THREAD.getByName(group).submit(input(1, "下载队服照片发一下", 10000004, 200000001, true));
      const sent = await action(frames);
      expect(sent.params).toMatchObject({ group_id: "200000001", message: [
        { type: "at", data: { qq: "10000004" } },
        { type: "image", data: { file: expect.stringContaining("/media/object?token=") } },
      ] });
      const image = sent.params.message?.find(segment => segment.type === "image");
      if (!Check(Type.Object({ data: Type.Object({ file: Type.String() }) }), image)) throw Error("missing_image");
      const token = new URL(image.data.file).searchParams.get("token");
      if (!token) throw Error("missing_token");
      const asset = await readMediaToken(env.ASSETS, token);
      expect(asset.bytes).toEqual(png);
      expect(asset.ref).toMatchObject({ scope: group, name: "队服.png", kind: "image" });
      reply(socket, sent.echo);
      expect(await run).toEqual({ status: "done" });
      expect(seen.images).toContain(data);
      expect((await env.SANDBOX.getByName(group).readBlob("out/jersey.png")).bytes).toEqual(png);
      expect(await env.SANDBOX.getByName(group).readObject(seen.saved[0]!)).toEqual(png);
      for (const scope of ["owner", "group:200000002"]) {
        await runInDurableObject(env.SANDBOX.getByName(scope), async instance => { if (!(instance instanceof SandboxDO)) throw Error("expected SandboxDO"); await expect(instance.readBlob("out/jersey.png")).rejects.toThrow("not_found"); });
        await expect(new MediaRepository({ bucket: env.ASSETS, scope }).get(asset.ref.id)).rejects.toThrow("asset_not_found");
      }
    });
  
    it("群网页回合使用所属工作区，send_file 只写网页输出", async () => {
      await installRuntime(group);
      const seen = inspectThenSend(), thread = env.THREAD.getByName(group);
      await thread.submitWeb(group, crypto.randomUUID(), "下载图片");
      const chat = async () => { await thread.syncAdminView(group); return env.REQUESTS.getByName("view:thread:" + group).chatView(group); };
      await expect.poll(async () => (await chat()).messages.some(m => m.role === "assistant"), { timeout: 5000 }).toBe(true);
      await expect.poll(async () => (await chat()).active, { timeout: 5000 }).toBe(0);
      expect((await chat()).messages.find(m => m.role === "assistant")).toMatchObject({
        source: "web", assets: [{ scope: group, name: "队服.png", kind: "image" }],
      });
      expect(seen.images).toContain(data);
      expect(await env.BRIDGE.getByName("napcat").deliveryList()).toHaveLength(0);
    });
  
    it("群执行中会话代次撤销后，后续嵌套调用和发送均拒绝", async () => {
      const exec = vi.spyOn(SandboxDO.prototype, "exec").mockImplementation(async () => {
        await runInDurableObject(env.THREAD.getByName(group), (_instance, state) => { state.storage.sql.exec("UPDATE session_state SET generation=generation+1 WHERE id=1"); });
        return { stdout: "first", stderr: "", code: 0, timedOut: false, truncated: false };
      });
      const exported = vi.spyOn(SandboxDO.prototype, "exportAsset");
      const seen = scriptedModel([
        { name: "codemode", args: { code: 'text(await tools.bash({command:"first"})); text(await tools.bash({command:"second"}));' } },
        { name: "send_file", args: { path: "out/jersey.png" } },
      ]);
      await env.THREAD.getByName(group).submit(input(1, "运行", 10000004, 200000001, true));
      expect(exec).toHaveBeenCalledTimes(1);
      expect(exported).not.toHaveBeenCalled();
      expect(seen.outputs.join("\n")).toContain("本回合无权使用沙箱工具");
      expect(await env.BRIDGE.getByName("napcat").deliveryList()).toHaveLength(0);
    });
  
    it("开放群工作区仍限制 Cloudflare 资源管理与技能发布", async () => {
      const publish = vi.spyOn(RegistryDO.prototype, "skillPublish");
      const seen = scriptedModel([{ name: "codemode", args: { code: 'text(ALL_TOOLS.map(tool => tool.name)); try { text(await tools.skill_inspect({path:"out/skill"})); } catch(error) { text(String(error)); } try { text(await tools.skill_publish({path:"out/skill",workspaceRevision:"0",expectedRevision:"absent"})); } catch(error) { text(String(error)); }' } }]);
      await env.THREAD.getByName(group).submit(input(1, "检查工具", 10000004, 200000001, true));
      expect(seen.outputs.join("\n")).toContain("skill_publish_denied");
      expect(seen.outputs.join("\n")).not.toMatch(/sandbox_list|sandbox_create|web_import_image|web_fetch/);
      expect(publish).not.toHaveBeenCalled();
    });
  
    it.each(["private", "self", "schedule"] as const)("拒绝 %s 回合的脚本执行", async kind => {
      const exec = vi.spyOn(SandboxDO.prototype, "exec");
      scriptedModel([{ name: "codemode", args: { code: 'text(await tools.bash({command:"forbidden"}));' } }]);
      const incoming = input(1, "运行", kind === "self" ? 10000000 : 10000004, kind === "private" ? undefined : 200000001, true);
      await env.THREAD.getByName(kind === "private" ? "private:10000004" : group).submit({ ...incoming, ...(kind === "schedule" ? { kind: "schedule" as const } : {}) });
      expect(exec).not.toHaveBeenCalled();
    });
  });
});

import { env, evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import * as models from "../src/models";
import { MEMORY_EXTRACT_PROMPT } from "../src/memory/extractor";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredEdge, assertNoCredentials, fingerprint, messageId, type AgentMessage, type AgentReceipt, type AgentSend } from "../src/communication/model";
import { allowed, importFiles, reserveAgent, sendAgent, verifyMessage } from "../src/communication/service";
import { EdgeStore } from "../src/communication/edges";
import { MediaRepository } from "../src/media/repository";
import type { InboundInput } from "../src/policy";
import type { InboundRow } from "../src/thread/model";
import type { SandboxTask } from "../src/sandbox/task-access";
import { action, connect, input, reply } from "./helpers";
import { scriptedModel } from "./events-helpers";

describe("agent communication core", () => {
  const sockets: WebSocket[] = [];
  afterEach(async () => { for (const socket of sockets.splice(0)) socket.close(); vi.restoreAllMocks(); await reset(); });
  const group = "group:200000001";
  type Internal = {
    queueInput(input: InboundInput): Promise<string>;
    sendAgentMessage(args: AgentSend, seed: string, input: InboundRow): Promise<AgentReceipt>;
    sandboxTaskForInput(input: InboundRow): Promise<SandboxTask | undefined>;
  };
  async function seed(scope: string, value: InboundInput) {
    await runInDurableObject(env.THREAD.getByName(scope), async (instance, state) => {
      await (instance as unknown as Internal).queueInput(value);
      // Receipt tests stop before model execution; model scheduling is covered separately.
      state.storage.sql.exec("UPDATE inbound SET turn_id='local-turn',status='done'");
      await state.storage.deleteAlarm();
    });
  }
  async function send(from: string, args: AgentSend, id = "send-1") {
    return runInDurableObject(env.THREAD.getByName(from), async (instance, state) => {
      const source = state.storage.sql.exec("SELECT * FROM inbound WHERE kind='message' ORDER BY rowid DESC LIMIT 1").one() as unknown as InboundRow;
      return (instance as unknown as Internal).sendAgentMessage(args, id, source);
    });
  }
  async function rows(scope: string) {
    return runInDurableObject(env.THREAD.getByName(scope), (_instance, state) => state.storage.sql.exec("SELECT * FROM inbound WHERE kind='agent'").toArray() as unknown as InboundRow[]);
  }
  
  describe("agent communication MVP", () => {
    it("uses directional session edges, not the triggering person or QQ grants", () => {
      expect(configuredEdge(undefined, "owner", group)).toBe(false);
      const config = JSON.stringify([["owner", group]]);
      expect(configuredEdge(config, "owner", group)).toBe(true);
      expect(configuredEdge(config, group, "owner")).toBe(false);
      expect(configuredEdge(config, "owner", "group:200000002")).toBe(false);
      expect(() => configuredEdge('[["owner","*"]]', "owner", group)).toThrow("agent_invalid_config");
      expect(() => assertNoCredentials("", "/work/.env")).toThrow("agent_credentials_forbidden");
      expect(() => assertNoCredentials("refresh_token=synthetic-long-token")).toThrow("agent_credentials_forbidden");
    });
  
    it("thread to thread enters existing inbound once, preserves local authority, never impersonates owner or automatically sends QQ", async () => {
      await seed("owner", input(1, "owner local", 10000001));
      await seed(group, input(2, "member local", 10000003, 200000001));
      const accepted = await send("owner", { to: group, text: "peer message" });
      expect(accepted.status).toBe("accepted");
      expect((await send("owner", { to: group, text: "peer message" })).status).toBe("duplicate");
      await expect(send("owner", { to: group, text: "changed" })).rejects.toThrow("agent_message_conflict");
      const received = await rows(group);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ kind: "agent", user_id: "", self_id: "10000000", agent_from: "owner" });
      // 入箱回执与 alarm 接纳可并行；尚未接纳为 null，接纳后只能是 followUp。
      expect([null, "followUp"]).toContain(received[0]?.when_busy);
      await runInDurableObject(env.THREAD.getByName(group), async (instance, state) => {
        const api = instance as unknown as Internal, row = received[0]!;
        const source = state.storage.sql.exec("SELECT * FROM inbound WHERE message_id=?", row.agent_authority!).one() as unknown as InboundRow;
        const previous = await api.sandboxTaskForInput(source), current = await api.sandboxTaskForInput(row);
        expect(previous?.permissions.coding).toBe(true);
        expect(current).toBeUndefined();
        expect(state.storage.sql.exec("SELECT * FROM outgoing_intents").toArray()).toHaveLength(0);
        // 升级前已入箱的 Agent 行只有哨兵；缺失原授权记录时不能猜测机器人身份。
        const deliverySource = { thread: group, inputId: row.message_id, generation: row.session_generation, scope: group };
        const target = { kind: "group" as const, groupId: "200000001" };
        state.storage.sql.exec("UPDATE inbound SET self_id='agent' WHERE message_id=?", row.message_id);
        expect(await instance.validateDeliverySource(deliverySource, target)).toBe(true);
        state.storage.sql.exec("UPDATE inbound SET agent_authority=NULL WHERE message_id=?", row.message_id);
        expect(await instance.validateDeliverySource(deliverySource, target)).toBe(false);
      });
      // A different group member still speaks through the same session edge.
      await seed(group, input(3, "another member", 10000004, 200000001));
      expect((await send(group, {to:"owner",text:"reply"}, "reply")).status).toBe("accepted");
      await expect(send(group, {to:"group:200000002",text:"denied"})).rejects.toThrow("agent_session_denied");
    });
  
    it("sends text and a received file only to the local QQ user route, sharing one two-send budget", async () => {
      await seed("owner", input(1, "owner", 10000001));
      await seed(group, input(2, "member", 10000003, 200000001));
      await env.SANDBOX.getByName("owner").saveAttachment("/work/report.txt", new TextEncoder().encode("report"));
      await env.SANDBOX.getByName(group).saveAttachment("/work/private.txt", new TextEncoder().encode("not received"));
      const deliverySeed = "local-qq-report";
      const path = "/work/agent-files/" + messageId("owner", "0:" + deliverySeed).slice(6) + "/0-report.txt";
      const privateImage = await new MediaRepository({ bucket: env.ASSETS, scope: group }).put({
        bytes: Uint8Array.of(137,80,78,71,13,10,26,10), name: "local.png", kind: "image",
      });
      const seen = scriptedModel([
        { name: "send_message", args: { text: "wrong group", target: "qq:group:200000002" } },
        { name: "send_file", args: { path: "/work/private.txt" } },
        { name: "send_message", args: { text: "refresh_token=synthetic-test-value" } },
        { name: "send_message", args: { text: "", images: [privateImage.id] } },
        { name: "send_message", args: { text: "result ready" } },
        { name: "send_file", args: { path } },
        { name: "send_message", args: { text: "extra" } },
      ]);
      const { socket, frames } = await connect(sockets);
      expect((await send("owner", {to:group, text:"report", files:["/work/report.txt"]}, deliverySeed)).files).toEqual([path]);
      const message = await action(frames);
      expect(message.params).toMatchObject({ group_id:"200000001", message:[{type:"text",data:{text:"result ready"}}] });
      reply(socket, message.echo);
      const file = await action(frames, 0, "upload_group_file");
      expect(file.params).toMatchObject({group_id:"200000001",name:"0-report.txt"});
      reply(socket, file.echo, 90000002);
      await expect.poll(() => seen.outputs.join("\n"), {timeout:5000}).toContain("agent_turn_send_limit");
      expect(seen.outputs[0]).toContain("send_denied");
      expect(seen.outputs[1]).toContain("agent_file_access_denied");
      expect(seen.outputs[2]).toContain("agent_credentials_forbidden");
      expect(seen.outputs[3]).toContain("agent_file_access_denied");
      expect(await env.BRIDGE.getByName("napcat").deliveryList()).toHaveLength(2);
      const history = await runInDurableObject(env.THREAD.getByName(group), (_instance, state) =>
        state.storage.sql.exec("SELECT user_id, reply_to_id FROM messages WHERE is_self=1 AND message_id='90000001'").one());
      expect(history).toEqual({ user_id: "10000000", reply_to_id: null });
    });
  
    it("queues a peer behind a busy thread and consumes it through the native runtime", async () => {
      let started = false, seenPeer = false, release = () => {};
      const gate = new Promise<void>(resolve => { release = resolve; });
      const faux = fauxProvider({models:[{id:"test"}],tokensPerSecond:Infinity});
      const respond: FauxResponseFactory = async transcript => {
        faux.setResponses([respond]);
        if (transcript.messages.some(m=>m.role==="user" && typeof m.content==="string" && m.content.startsWith(MEMORY_EXTRACT_PROMPT))) return fauxAssistantMessage("[]");
        const user = transcript.messages.findLast(m=>m.role==="user");
        const content = typeof user?.content==="string" ? user.content : "";
        if (content.includes("[Agent 通信")) { seenPeer = true; return fauxAssistantMessage("peer handled"); }
        if (!started) { started = true; await gate; }
        return fauxAssistantMessage("local handled");
      };
      faux.setResponses([respond]);
      vi.spyOn(models,"openModels").mockImplementation((_env,credentials) => {
        const registry = createModels({credentials});registry.setProvider(faux.provider);return registry;
      });
      await seed("owner",input(1,"owner",10000001));
      const busy = env.THREAD.getByName(group).submit(input(2,"busy",10000003,200000001));
      await vi.waitFor(()=>expect(started).toBe(true));
      expect((await send("owner",{to:group,text:"queued peer"})).status).toBe("accepted");
      expect(seenPeer).toBe(false);
      expect((await rows(group))[0]).toMatchObject({status:"queued",when_busy:null});
      const display=env.REQUESTS.getByName("view:thread:"+group);
      await env.THREAD.getByName(group).syncAdminView(group);
      const queued=(await display.chatView(group)).messages.find(m=>m.source==="agent-in");
      expect(queued).toMatchObject({status:"waiting",text:"尚无入模记录"});
      release();
      await busy;
      await vi.waitFor(()=>expect(seenPeer).toBe(true),{timeout:10000});
      await vi.waitFor(async()=>expect((await rows(group))[0]?.status).toBe("done"),{timeout:10000});
      expect((await rows(group))[0]?.when_busy).toBe("followUp");
      await env.THREAD.getByName(group).syncAdminView(group);
      expect((await display.chatView(group)).messages.filter(m=>m.source==="agent-in")).toMatchObject([{id:queued!.id,text:"queued peer",status:"done"}]);
    });
  
    it("rejects forged source and payload, including source-scope asset substitution", async () => {
      await seed("owner", input(1, "owner local", 10000001));
      await seed(group, input(2, "group local", 10000003, 200000001));
      const message: AgentMessage = { id: messageId("owner", "forged"), from: "owner", to: group, text: "not sent", files: [] };
      expect(fingerprint(message)).toMatch(/^[a-f0-9]{64}$/);
      const error = await runInDurableObject(env.THREAD.getByName(group), async instance => {
        try { await instance.agentReceive(message); return ""; } catch (error) { return (error as Error).message; }
      });
      expect(error).toBe("agent_source_unverified");
      expect(await rows(group)).toHaveLength(0);
    });
  
    it("revokes source proofs on session reset without trusting replayed source metadata", async () => {
      await seed("owner",input(1,"owner",10000001));
      await seed(group,input(2,"member",10000003,200000001));
      const receipt = await send("owner",{to:group,text:"before reset"});
      await runInDurableObject(env.THREAD.getByName("owner"), async (instance,state) => {
        const sent = await state.storage.get<{hash:string}>("agent-sent:"+receipt.messageId);
        expect(await instance.agentProof(receipt.messageId,sent!.hash)).toBe(true);
        state.storage.sql.exec("UPDATE session_state SET generation=1");
        expect(await instance.agentProof(receipt.messageId,sent!.hash)).toBe(false);
      });
      await expect(send("owner",{to:group,text:"stale input"},"stale")).rejects.toThrow("agent_session_revoked");
    });
  
    it("copies actual R2 bytes into target scope and passes only target workspace paths to the consumer", async () => {
      const bytes = new TextEncoder().encode("immutable artifact");
      const source = new MediaRepository({ bucket: env.ASSETS, scope: "owner" });
      const ref = await source.put({bytes, name:"artifact.txt",mime:"text/plain"});
      const message: AgentMessage = {id:messageId("owner","file"),from:"owner",to:group,text:"",files:[ref]};
      const writes = new Map<string, Uint8Array>();
      const paths = await importFiles(env, message, async (path, content) => { writes.set(path, content); });
      expect(paths).toHaveLength(1);
      expect(new TextDecoder().decode(writes.get(paths[0]!))).toBe("immutable artifact");
      const target = new MediaRepository({bucket:env.ASSETS,scope:group});
      const expected = await target.put({bytes,name:"artifact.txt",mime:"text/plain",kind:"file"});
      expect(new TextDecoder().decode((await target.get(expected.id)).bytes)).toBe("immutable artifact");
      await expect(target.get(ref.id)).rejects.toThrow("asset_not_found");
      await expect(importFiles(env,{...message,files:[{...ref,scope:"private:123"}]},async()=>{})).rejects.toThrow("agent_asset_scope_denied");
      // The save callback above is deliberately a fixture: this is NOT a real SandboxDO deployment/read acceptance test.
    });
  });
});

describe("agent edge policy", () => {
  const from = 'owner', to = 'group:200000001', actor = 'qq:10000001';
  afterEach(reset);
  it('retains a baseline deny after eviction and rechecks reservations, sends and receipts', async () => {
    await runInDurableObject(env.THREAD.getByName(from), async (_, state) => {
      const registry = env.REGISTRY.getByName('main');
      const host = { env, storage: state.storage, agentSessionId: from, generation: 0, readFile: async () => { throw Error(); } };
      const input = {to, text:'pending'}, ticket = await reserveAgent(host, input, 'ticket', Date.now());
      await registry.edgeSet(from, to, 'deny', actor);
      await evictDurableObject(registry);
      expect(await registry.edgeList()).toContainEqual(expect.objectContaining({from,to,baseline:true,override:'deny',effective:false,actor}));
      await expect(reserveAgent(host, input, 'new', Date.now())).rejects.toThrow('agent_session_denied');
      await expect(sendAgent(host, input, 'ticket', undefined, ticket)).rejects.toThrow('agent_session_denied');
      await expect(verifyMessage(env, to, {...input, from, files:[], id:'agent:'+'a'.repeat(64)})).rejects.toThrow('agent_session_denied');
      expect(await allowed(env,to,from)).toBe(true);
    });
  });
  it('needs two independent grants and rejects invalid writes or configuration even with an allow', async () => {
    const peer = 'private:42', registry = env.REGISTRY.getByName('main');
    await registry.edgeSet(from,peer,'allow',actor);
    expect(await allowed(env,from,peer)).toBe(true);
    expect(await allowed(env,peer,from)).toBe(false);
    await registry.edgeSet(peer,from,'allow',actor);
    expect(await allowed(env,peer,from)).toBe(true);
    for (const bad of [from,'*','sub:owner:'+'a'.repeat(36)]) await expect(async()=>await registry.edgeSet(from,bad,'allow',actor)).rejects.toThrow();
    await runInDurableObject(registry, (_, state) => {
      const broken = new EdgeStore(state.storage,'not json');
      expect(()=>broken.allowed(from,peer)).toThrow('agent_invalid_config');
      expect(()=>broken.set(from,peer,'deny',actor)).toThrow('agent_invalid_config');
      expect(state.storage.sql.exec('SELECT * FROM agent_edge_audit').toArray()).toHaveLength(2);
    });
  });
});

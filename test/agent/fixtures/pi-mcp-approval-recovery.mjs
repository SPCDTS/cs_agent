import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { PiMcp } from "../../../dist/agent/pi-mcp/index.js";
import { McpApprovals } from "../../../dist/agent/pi-mcp/approval.js";
import { parseMcpConfig } from "../../../dist/agent/pi-mcp/config.js";

const [mode, directory, url] = process.argv.slice(2);
const send = message => process.send?.(message);

async function main() {
  const registry = createRegistry(), models = createModels();
  const faux = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: Infinity }); models.setProvider(faux.provider);
  const host = await Harness.open(await openNodeSqliteStorage(path.join(directory, "agent.sqlite")), { registry: createRegistry(), models }, context);
  const storage = await openNodeSqliteStorage(path.join(directory, "pi.sqlite"));
  const harness = await Harness.open(storage, { registry, models, settings: { extensions: [], retry: { maxRetries: 0 } } }, context);
  const config = parseMcpConfig({ version: 1, enabled: true, servers: [{ id: "fixture",
    transport: { kind: "streamable-http", url, allowLoopbackHttp: true }, credential: { kind: "none" },
    tools: { allow: ["first"], approval: ["first"] }, access: { kind: "owner-private", groups: ["7"] }, replay: "unsafe" }] });
  const binding = { threadKey: "group:7", scope: "group:7", identity: { kind: "user", sender: "5" },
    inputs: [], child: false, access: "group:7", senderIsOwner: false, auth: false };
  const notices = [];
  let mcp;
  const approvals = new McpApprovals({ getHarness: () => host, config, owners: () => ["1"], input: () => null,
    invoke: record => mcp.executeApproval(record), send: { system: async (_binding, text) => {
      notices.push(text); return { status: "sent", message_id: String(notices.length), already_sent: false, message_type: "group", target_id: "7" };
    } } });
  try {
    mcp = await PiMcp.attach({ registry, harness, storage, config, approvals, owners: () => ["1"], binding: async () => binding,
      secrets: { readReferencedVariable: () => undefined } });
    if (mode === "approval-run") {
      const model = faux.getModel();
      const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: model.provider, modelId: model.id } } }, context);
      await mcp.configure({ conversation, turn: binding }, context);
      const tool = (await conversation.agent(context)).tools.find(t => t.name.startsWith("mcp_fixture_first_"));
      if (!tool) throw new Error("missing_tool");
      faux.setResponses([fauxAssistantMessage(fauxToolCall(tool.name, { project: "stored-approval" }), { stopReason: "toolUse" }), fauxAssistantMessage("等待审批")]);
      harness.resume();
      await (await conversation.submit({ type: "input", content: "申请编辑" }, context)).wait(context);
      const record = (await approvals.records())[0];
      if (!record || record.state !== "pending") throw new Error("missing_approval");
      send({ phase: "ready" });
      await approvals.handle({ key: "owner-decision", kind: "user", seq: 2, scope: "group:7", thread_key: "group:7", self_id: "2",
        user_id: "1", group_id: "7", message_type: "group", message_id: "owner-1", nickname: "主人", text: `批准 #${record.code}`,
        route_text: `批准 #${record.code}`, time: Date.now() / 1000, images: [], attachments: [], created_at: new Date().toISOString(), state: "queued" }, () => {});
    } else {
      await approvals.recover();
      send({ phase: "approval_recovered", states: (await approvals.records()).map(r => r.state), notices });
    }
  } finally {
    mcp?.beginShutdown();
    await host.close(context); await harness.close(context); await mcp?.close();
  }
}
main().catch(error => { send({ phase: "error", message: String(error) }); process.exitCode = 1; }).finally(() => process.disconnect?.());

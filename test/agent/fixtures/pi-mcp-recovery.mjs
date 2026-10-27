import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { AgentDoc, createRegistry, Harness, watchEvents } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { PiMcp } from "../../../dist/agent/pi-mcp/index.js";
import { parseMcpConfig } from "../../../dist/agent/pi-mcp/config.js";
import { trace } from "../../../dist/shared/trace.js";

const [mode, directory, url] = process.argv.slice(2);
const context = BACKGROUND_CONTEXT;
const send = message => process.send?.(message);

/** 只运行真实 Pi 存储与 MCP；业务 main 不参与。 */
async function main() {
  const registry = createRegistry(), models = createModels();
  const faux = fauxProvider({ provider: "mcp-recovery", models: [{ id: "test" }], tokensPerSecond: Infinity });
  models.setProvider(faux.provider);
  const binding = { threadKey: "owner", scope: "private:1", identity: { kind: "user", sender: "1" },
    inputs: [], access: "all", senderIsOwner: true, auth: true, child: false };
  // 恢复进程使用同一份可用配置：重发与否只取决于 Pi 的 unsafe 恢复，而不是连接被禁用。
  const config = parseMcpConfig({
    version: 1, enabled: true, servers: [{ id: "fixture", enabled: true,
      transport: { kind: "streamable-http", url, allowLoopbackHttp: true },
      credential: { kind: "none" }, tools: { allow: ["first"] }, access: { kind: "owner-private" }, replay: "unsafe" }],
  });
  if (config.kind === "invalid") throw new Error("fixture_config_invalid");
  const storage = await openNodeSqliteStorage(path.join(directory, "pi.sqlite"));
  const harness = await Harness.open(storage, {
    models, registry, settings: { extensions: [], retry: { maxRetries: 0 } },
  }, context);
  let mcp, stream;
  const terminals = [];
  const off = trace.tap(event => {
    if (event.stage === "mcp_recovered_terminal") terminals.push(event.detail.code);
  });
  try {
    mcp = await PiMcp.attach({ registry, harness, storage, config, secrets: { readReferencedVariable: () => undefined },
      owners: () => ["1"], binding: async () => binding });
    const metadataFile = path.join(directory, "conversation.json");
    let conversation;
    if (mode === "recover") {
      const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
      if (!Number.isSafeInteger(metadata.conversation)) throw new Error("fixture_conversation_invalid");
      conversation = await harness.conversation(metadata.conversation, context);
      if (!conversation) throw new Error("fixture_conversation_missing");
      faux.setResponses([fauxAssistantMessage("恢复后完成")]);
    } else {
      const model = faux.getModel();
      conversation = await harness.createConversation({ ownership: { kind: "ownerless" },
        agent: { model: { provider: model.provider, modelId: model.id } } }, context);
      await mcp.configure({ conversation, turn: binding }, context);
      const tool = (await conversation.agent(context)).deferred.find(item => item.name.startsWith("mcp_"));
      if (!tool) throw new Error("fixture_mcp_tool_missing");
      // 视同模型已用 tool_search 加载这个延迟工具。
      await harness.commit(async tx => { (await tx.doc(AgentDoc, conversation.id)).modelTools = { add: [tool.name] }; }, context);
      await writeFile(metadataFile, JSON.stringify({ conversation: Number(conversation.id) }), "utf8");
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall(tool.name, {}), { stopReason: "toolUse" }),
        async () => {
          // 第二次请求只能在工具结果已经提交之后进入；保持进程供父测试强杀。
          send({ phase: "committed" });
          await new Promise(() => {});
          return fauxAssistantMessage("不应执行");
        },
      ]);
    }
    stream = await watchEvents(harness, conversation.id, context);
    mcp.observeEvent(Number(conversation.id), stream.snapshot);
    stream.start(async events => { for (const event of events) mcp.observeEvent(Number(conversation.id), event); });
    if (mode !== "recover") {
      await conversation.submit({ type: "input", requestId: "recovery-request", content: "执行一次计数" }, context);
      send({ phase: "ready" });
    }
    harness.resume();
    await conversation.waitForIdle(context);
    const entries = (await conversation.entries({ order: "ascending" }, 256, undefined, context)).items;
    // 再喂一次持久结果，验证恢复审计按条目去重。
    for (const entry of entries) mcp.observeEvent(Number(conversation.id), { type: "entry_appended", entry });
    const results = entries.filter(entry => entry.kind === "pi.tool-result").map(entry => {
      const message = entry.model?.find(item => item.role === "toolResult");
      return { isError: message?.isError === true, codes: (entry.data?.diagnostics ?? []).map(item => item.code ?? ""),
        text: message?.content.filter(item => item.type === "text").map(item => item.text).join("\n") ?? "" };
    });
    send({ phase: "recovered", results, terminals, pending: (await harness.inspect(context)).submissions.length });
  } finally {
    off(); mcp?.beginShutdown();
    await stream?.stop();
    try { await harness.close(context); } finally { await mcp?.close(); }
  }
}

main().catch(error => { send({ phase: "error", message: String(error) }); process.exitCode = 1; })
  .finally(() => { process.disconnect?.(); });

import { env, reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { hostedModelId } from "../src/codex-hosted";
import { openModels } from "../src/models";
import { codexSearch } from "../src/search";
import { codexImage } from "../src/tools/generate-image";
import { CODEX_URL, codexStore } from "./codex-helpers";

// 真实请求 ChatGPT 订阅，默认跳过。CODEX_PROBE=1 时 vitest.config.ts 从本机 Codex CLI 的 auth.json 注入凭据：
//   CODEX_PROBE=1 npx vitest run test/codex-image.probe.test.ts
// 只打印状态码、输出项类型、分类与长度，不打印凭据或图片内容。
const probe = env as unknown as { CODEX_PROBE?: string; CODEX_PROBE_ACCESS?: string; CODEX_PROBE_ACCOUNT?: string };
const enabled = probe.CODEX_PROBE === "1";
afterEach(async () => { await reset(); });

async function useProbeLogin(): Promise<void> {
  // 不带可用的 refresh token：access token 过期时请求会 401，探针报 login_required，需要先在本机重新登录 Codex CLI。
  await codexStore().modify("openai-codex", async () => ({ type: "oauth", access: probe.CODEX_PROBE_ACCESS!, refresh: "probe-no-refresh",
    expires: Date.now() + 3600_000, accountId: probe.CODEX_PROBE_ACCOUNT! }));
}
const classify = (error: unknown) => (error as { code?: string }).code ?? (error instanceof Error ? error.message.slice(0, 200) : String(error));

describe.skipIf(!enabled)("Codex hosted tools probe (real ChatGPT subscription)", () => {
  it("shows whether the raw responses endpoint accepts image_generation", async () => {
    const model = hostedModelId(openModels(env, codexStore()));
    const response = await fetch(CODEX_URL, { method: "POST", headers: {
      Authorization: `Bearer ${probe.CODEX_PROBE_ACCESS}`, "chatgpt-account-id": probe.CODEX_PROBE_ACCOUNT!, "OpenAI-Beta": "responses=experimental",
      originator: "pi", accept: "text/event-stream", "content-type": "application/json",
    }, body: JSON.stringify({ model, store: false, stream: true, instructions: "You are a helpful assistant.",
      input: [{ role: "user", content: [{ type: "input_text", text: "Use the image_generation tool to draw a small red circle on a white background." }] }],
      tools: [{ type: "image_generation", size: "1024x1024", quality: "medium" }], tool_choice: "auto", parallel_tool_calls: true,
      reasoning: { effort: "low" }, text: { verbosity: "low" }, include: [] }) });
    const text = await response.text();
    const report: Record<string, unknown> = { model, status: response.status };
    if (!response.ok) report.error = text.slice(0, 800);
    else {
      const events = text.split("\n").filter(line => line.startsWith("data: ")).flatMap(line => { try { return [JSON.parse(line.slice(6))]; } catch { return []; } });
      const items = events.filter(event => event.type === "response.output_item.done").map(event => event.item);
      report.items = items.map(item => item.type);
      report.image = items.filter(item => item.type === "image_generation_call")
        .map(item => ({ status: item.status, base64Length: typeof item.result === "string" ? item.result.length : 0, png: typeof item.result === "string" && item.result.startsWith("iVBORw0KGgo") }));
      report.errors = events.filter(event => event.type === "error" || event.type === "response.failed").map(event => JSON.stringify(event).slice(0, 800));
    }
    console.log("codex image probe (raw)", JSON.stringify(report, null, 2));
    expect(report.status).toBeTypeOf("number");
  }, 240_000);

  it("runs codexSearch and codexImage end to end through pi-ai", async () => {
    await useProbeLogin();
    const models = openModels(env, codexStore()), report: Record<string, unknown> = { model: hostedModelId(models) };
    try { report.search = (await codexSearch(models, "Cloudflare Durable Objects pricing", { maxResults: 3 })).results; }
    catch (error) { report.search = classify(error); }
    try {
      const image = await codexImage(models, "a small red circle on a white background", "1024x1024", {});
      report.image = { base64Length: image.length, png: image.startsWith("iVBORw0KGgo") };
    } catch (error) { report.image = classify(error); }
    console.log("codex hosted tools probe (pi-ai)", JSON.stringify(report, null, 2));
    expect(report.model).toBeTypeOf("string");
  }, 300_000);
});

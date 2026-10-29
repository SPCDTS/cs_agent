import { env } from "cloudflare:test";
import { vi } from "vitest";
import { remoteCredentials } from "../src/model-credentials";

// 全部为合成值：不签名的 JWT 只带 pi-ai 要读的 chatgpt_account_id。
export const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const jwt = (payload: object) => ["e30", Buffer.from(JSON.stringify(payload)).toString("base64url"), "synthetic"].join(".");
export const codexStore = () => remoteCredentials(() => env.REGISTRY.getByName("main"));
export async function codexLogin(): Promise<void> {
  await codexStore().modify("openai-codex", async () => ({ type: "oauth", access: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } }),
    refresh: "synthetic-refresh", expires: Date.now() + 3600_000, accountId: "synthetic-account" }));
}

export type CodexBody = { model: string; tools?: unknown[]; input: unknown[] };
async function requestBody(request: Request): Promise<CodexBody> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (request.headers.get("content-encoding") !== "zstd") return JSON.parse(new TextDecoder().decode(bytes));
  const zlib = await import("node:zlib") as unknown as { zstdDecompressSync(data: Uint8Array): Uint8Array };
  return JSON.parse(new TextDecoder().decode(zlib.zstdDecompressSync(bytes)));
}
/** 伪造 Codex responses 端点；其他地址一律报错，测试不出网。 */
export function fakeCodex(respond: (body: CodexBody) => Response) {
  const bodies: CodexBody[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const request = new Request(url, init);
    if (request.url !== CODEX_URL) throw new Error(`network disabled in tests: ${request.url}`);
    const body = await requestBody(request);
    bodies.push(body);
    return respond(body);
  });
  return { bodies };
}

export const sse = (events: object[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
export const hostedItem = (index: number, item: Record<string, unknown>) => [
  { type: "response.output_item.added", output_index: index, item: { ...item, status: "in_progress" } },
  { type: "response.output_item.done", output_index: index, item },
];
export const messageItem = (index: number, text: string) => [
  { type: "response.output_item.added", output_index: index, item: { type: "message", id: `msg_${index}`, role: "assistant", content: [] } },
  { type: "response.output_text.delta", output_index: index, delta: text },
  { type: "response.output_item.done", output_index: index, item: { type: "message", id: `msg_${index}`, role: "assistant", status: "completed", content: [{ type: "output_text", text }] } },
];
export const completed = { type: "response.completed", response: { status: "completed", usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } };

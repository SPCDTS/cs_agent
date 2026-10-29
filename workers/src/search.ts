import type { Models } from "@earendil-works/pi-ai";
import { HostedToolError, runHostedTool } from "./codex-hosted";
import { stripTracking } from "./send-clean";

export type SearchResult = { title: string; url: string; snippet: string };
export const SEARCH_TIMEOUT_MS = 60_000;

export const searchPrompt = (query: string, maxResults: number) =>
  `用 web_search 工具搜索下面的查询，只返回结果列表：每条一行，格式 \`标题 | URL | 一句话摘要\`，最多 ${maxResults} 条，不要评论，不要省略 URL。查询：${query}`;

/** 代搜模型按行输出 `标题 | URL | 摘要`；它偶尔加序号、Markdown 链接或尖括号，按 URL 定位切分，比按竖线切更稳。 */
export function parseResults(text: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [], seen = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, "");
    const found = /https?:\/\/[^\s|<>()\[\]]+/.exec(line);
    if (!found) continue;
    const url = stripTracking(found[0].replace(/[.,;:，。；]+$/, ""));
    if (seen.has(url)) continue;
    seen.add(url);
    const title = line.slice(0, found.index).replace(/[\s|\[\]()<]+$/, "").replace(/^\[/, "").trim();
    const snippet = line.slice(found.index + found[0].length).replace(/^[\s|\])>]+/, "").trim();
    results.push({ title: title || url, url, snippet });
    if (results.length >= maxResults) break;
  }
  return results;
}

/**
 * 由 ChatGPT 订阅的托管 web_search 代任何模型联网搜索。代搜模型可能根本没搜而是凭记忆作答，
 * 所以响应里没有 web_search_call 输出项就视为没搜，整份结果丢弃。
 */
export async function codexSearch(models: Models, query: string,
  options: { signal?: AbortSignal; maxResults: number; modelId?: string }): Promise<{ results: SearchResult[] }> {
  const { text, calls } = await runHostedTool(models, searchPrompt(query, options.maxResults), { type: "web_search" },
    { signal: options.signal, timeoutMs: SEARCH_TIMEOUT_MS, modelId: options.modelId });
  if (!calls.length) throw new HostedToolError("not_searched");
  return { results: parseResults(text, options.maxResults) };
}

import type { ModelSelection } from "../settings";
import { containsSecret, redactSecrets } from "../memory/secrets";
import { sha256Hex } from "../shared/hash";
import type { SubagentReport } from "../subagent/model";
import type { AssetRef } from "../media/repository";

export const SESSION_PATTERN = "^(?:owner|(?:group|private):[1-9][0-9]{0,19}|sub:(?:owner|(?:group|private):[1-9][0-9]{0,19}):[0-9a-f-]{36})$";
export type AgentMessage = { id: string; from: string; to: string; text: string; files: AssetRef[]; targetGeneration?: number; childModel?: ModelSelection; report?: SubagentReport };
export type AgentReceipt = { messageId: string; status: "accepted" | "duplicate"; files: string[] };
export type AgentSend = { to: string; text?: string; files?: string[]; /** 仅父任务已授权的 message(model) 入口，非 agent_send 参数。 */ childModel?: ModelSelection };
export function sessionId(value: string): string {
  if (!new RegExp(SESSION_PATTERN).test(value)) throw new Error("agent_invalid_session");
  return value;
}
export function childAddress(value: string): { parent: string; id: string } | undefined {
  const match = /^sub:(.+):([0-9a-f-]{36})$/.exec(value);
  return match ? { parent: match[1]!, id: match[2]! } : undefined;
}
/** 部署配置是独立通信能力；不读取 QQ send grant，也不接受通配目标。 */
export function baselineEdges(config: string | undefined): [string, string][] {
  if (!config) return [];
  let edges: unknown;
  try { edges = JSON.parse(config); } catch { throw new Error("agent_invalid_config"); }
  if (!Array.isArray(edges) || edges.length > 100 || edges.some(edge => !Array.isArray(edge) || edge.length !== 2 ||
    edge.some(id => typeof id !== "string" || !new RegExp(SESSION_PATTERN).test(id)))) throw new Error("agent_invalid_config");
  return edges as [string, string][];
}
export function configuredEdge(config: string | undefined, from: string, to: string): boolean {
  return baselineEdges(config).some(edge => edge[0] === from && edge[1] === to);
}
export const fingerprint = (message: AgentMessage) => sha256Hex(JSON.stringify(message));
export const messageId = (from: string, seed: string) => "agent:" + sha256Hex(from + ":" + seed);
export function validateSend(input: AgentSend): void {
  sessionId(input.to);
  if (typeof input.text !== "undefined" && (typeof input.text !== "string" || input.text.length > 20000)) throw new Error("agent_invalid_text");
  if ((!input.text?.trim() && !input.files?.length) || (input.files?.length ?? 0) > 5) throw new Error("agent_empty_or_too_large");
  assertNoCredentials(input.text ?? "");
}
/** 纵深防护，不把任意二进制的语义扫描声称为凭据识别保证。 */
export function assertNoCredentials(text: string, path = ""): void {
  if (containsSecret(text) || containsSecret(path) || /(?:^|[/\\])(?:\.env(?:\..*)?|credentials?(?:\..*)?|cookies?(?:\..*)?|auth\.json|secrets?(?:\..*)?|login data|local state|private-key\.pem|id_rsa|id_ed25519|\.npmrc|\.netrc)$/i.test(path) ||
      /-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})|\b(?:authorization\s*[:=]\s*["']?(?:bearer|basic)\s+\S+|(?:access_token|refresh_token|client_secret|password)\s*["']?\s*[:=]\s*["']?[^\s"',}]{8,})/i.test(text)) {
    throw new Error("agent_credentials_forbidden");
  }
}

/** 自动报告保留非敏感正文；整段处理多行值，不能只删首行而泄露后续密钥。 */
export function redactReport(text: string): string {
  return redactSecrets(text
    .replace(/-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/gi, "[私钥已隐藏]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/gi, "[令牌已隐藏]")
    .replace(/\bauthorization\s*[:=]\s*["']?(?:bearer|basic)\s+[^\s"'<>]+/gi, "[认证已隐藏]"));
}

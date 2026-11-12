import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { DEFAULT_SETTINGS, normalizeEvent, parseSettings, type ExternalEvent, type SourceSettings } from "../events/model";

export const MAX_BODY = 256 * 1024;
import { CHOICES } from "./choices";
export { CHOICES } from "./choices";
const Repo = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}$" });
const ConfigSchema = Type.Object({
  repositoryIds: Type.Array(Type.Object({ installationId: Type.Integer({minimum:1,maximum:Number.MAX_SAFE_INTEGER}), repositoryId: Type.Integer({minimum:1,maximum:Number.MAX_SAFE_INTEGER}) }, {additionalProperties:false}), {maxItems:1000,uniqueItems:true}),
  selections: Type.Array(Type.String({ enum: [...CHOICES] }), { maxItems: CHOICES.length, uniqueItems: true }),
  paused: Type.Boolean(), settings: Type.Unknown(),
}, { additionalProperties: false });
export type GitHubConfig = Omit<Static<typeof ConfigSchema>, "settings"> & { settings: SourceSettings };
export const DEFAULT_GITHUB: GitHubConfig = {
  repositoryIds: [], selections: ["issues.opened", "pull_request.opened", "pull_request.ready_for_review", "release.published"],
  paused: false, settings: { ...DEFAULT_SETTINGS, filters: { requireLabels: [], excludeLabels: [], excludeSenders: [] } },
};
export function parseGitHubConfig(value: unknown): GitHubConfig | undefined {
  if (!Check(ConfigSchema, value)) return;
  const settings = parseSettings(value.settings);
  if (!settings) return;
  return { ...value, settings };
}
export class WebhookError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export async function readBounded(request: Request, max = MAX_BODY): Promise<Uint8Array> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d{1,10}$/.test(length) || Number(length) > max)) throw new WebhookError(413, "body_too_large");
  if (!request.body) throw new WebhookError(400, "missing_body");
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
    void reader.cancel().catch(() => {}); reject(new WebhookError(408, "body_timeout"));
  }, 5000); });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), timeout]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > max) { void reader.cancel().catch(() => {}); throw new WebhookError(413, "body_too_large"); }
      chunks.push(part.value);
    }
  } finally { clearTimeout(timer); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
export async function verifySignature(bytes: Uint8Array, signature: string, secret: string): Promise<boolean> {
  if (!secret || !/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, Uint8Array.from(signature.slice(7).match(/../g)!, hex => parseInt(hex, 16)), bytes);
}
const object = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const str = (v: unknown, max: number): string | undefined => typeof v === "string" && v.length <= max ? v : undefined;
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
export type GitHubDelivery = {
  deliveryId: string; bodyHash: string; repository: string; repositoryId: number; event: string; action: string;
  installationId?: number; lifecycleUserId?: number; lifecycle?: boolean;
  receivedAt: number; normalized: ExternalEvent | null;
};
/** No body, secret, URLs supplied by the sender, or routing fields survive this boundary. */
export async function readWebhook(request: Request, secret: string | undefined): Promise<GitHubDelivery> {
  if (!secret) throw new WebhookError(503, "unconfigured");
  const deliveryId = request.headers.get("x-github-delivery") ?? "", event = request.headers.get("x-github-event") ?? "";
  const signature = request.headers.get("x-hub-signature-256") ?? "";
  if (!/^[A-Za-z0-9-]{1,80}$/.test(deliveryId) || !/^[a-z_]{1,40}$/.test(event)
    || signature.length > 71 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? "")
    || request.headers.has("content-encoding")) throw new WebhookError(400, "invalid_headers");
  const bytes = await readBounded(request);
  if (!await verifySignature(bytes, signature, secret)) throw new WebhookError(401, "invalid_signature");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)); }
  catch { throw new WebhookError(400, "invalid_json"); }
  const p = object(value), repo = object(p?.repository);
  const installationId = object(p?.installation)?.id;
  if (event === "ping") {
    if (!positive(p?.hook_id)) throw new WebhookError(400,"invalid_ping");
    return {deliveryId,bodyHash:Buffer.from(await crypto.subtle.digest("SHA-256",bytes)).toString("hex"),
      repository:"",repositoryId:0,event,action:"",receivedAt:Date.now(),normalized:null};
  }
  const lifecycle = ["installation","installation_repositories","repository","github_app_authorization"].includes(event);
  if (event !== "github_app_authorization" && !positive(installationId)) throw new WebhookError(400,"invalid_installation");
  if (lifecycle) {
    const action = str(p?.action,40), userId = object(p?.sender)?.id;
    if (!action || !/^[a-z_]+$/.test(action) || event === "github_app_authorization" && (action !== "revoked" || !positive(userId)))
      throw new WebhookError(400,"invalid_lifecycle");
    return {deliveryId,bodyHash:Buffer.from(await crypto.subtle.digest("SHA-256",bytes)).toString("hex"), repository:"",repositoryId:0,
      installationId:positive(installationId)?installationId:undefined,lifecycleUserId:positive(userId)?userId:undefined,lifecycle:true,event,action,receivedAt:Date.now(),normalized:null};
  }

  const repository = str(repo?.full_name, 140), repositoryId = repo?.id;
  if (!p || !repository || !Check(Repo, repository) || !positive(repositoryId)
    || repository.split("/").some(part => part === "." || part === "..")) throw new WebhookError(400, "invalid_repository");
  const action = p.action === undefined ? "" : str(p.action, 40);
  if (action === undefined || action && !/^[a-z_]+$/.test(action)) throw new WebhookError(400, "invalid_action");
  const bodyHash = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex"), receivedAt = Date.now();
  let title = "", summary = "", path = "", valid = false;
  const item = object(p[event === "issues" ? "issue" : event === "pull_request" ? "pull_request" : event === "release" ? "release" : "workflow_run"]);
  if (event === "issues" || event === "pull_request") {
    valid = !!item && positive(item.number) && typeof item.title === "string" && item.title.length <= 4096 && !!action
      && (event !== "issues" || !item.pull_request);
    if (valid) { title = String(item!.title); path = (event === "issues" ? "/issues/" : "/pull/") + item!.number; summary = action; }
  } else if (event === "release") {
    valid = !!item && positive(item.id) && typeof item.tag_name === "string" && item.tag_name.length <= 256 && !!action;
    if (valid) { title = str(item!.name, 4096) ?? String(item!.tag_name); path = "/releases"; summary = action + " " + item!.tag_name; }
  } else if (event === "workflow_run") {
    valid = !!item && positive(item.id) && typeof item.name === "string" && item.name.length <= 4096 && !!action;
    if (valid) { title = String(item!.name); path = "/actions/runs/" + item!.id; summary = action + " " + (str(item!.conclusion, 64) ?? ""); }
  } else if (event === "push") {
    valid = !action && typeof p.ref === "string" && p.ref.length <= 512 && /^[0-9a-f]{40}$/.test(String(p.after ?? ""));
    if (valid) { title = "Push " + p.ref; path = "/commit/" + p.after; summary = "Repository push"; }
  }
  if (!valid) throw new WebhookError(400, "unsupported_or_invalid_event");
  const normalized = normalizeEvent({ source: "github", externalId: bodyHash,
    occurredAt: receivedAt, kind: "github." + event, title: repository + ": " + title, summary,
    actor: str(object(p.sender)?.login, 120) ?? "", ref: "https://github.com/" + repository + path })!;
  return { deliveryId, bodyHash, repository, repositoryId, event, action, receivedAt, normalized, installationId: positive(installationId) ? installationId : undefined };
}

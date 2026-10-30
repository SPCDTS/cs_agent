import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

export const FILE_MAX_BYTES = 10 * 1024 * 1024;
export const WORKSPACE_MAX_BYTES = 50 * 1024 * 1024;
export const ASSET_PREFIX = "cs-agent/v1";
export const AssetKindSchema = Type.Union([Type.Literal("image"), Type.Literal("file"), Type.Literal("audio"), Type.Literal("video")]);
export const AssetRefSchema = Type.Object({
  id: Type.String({ pattern: "^[a-f0-9]{64}$" }), scope: Type.String({ minLength: 1, maxLength: 240 }),
  sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }), bytes: Type.Integer({ minimum: 0, maximum: FILE_MAX_BYTES }),
  mime: Type.String({ minLength: 1, maxLength: 200 }), name: Type.String({ minLength: 1, maxLength: 255 }), kind: AssetKindSchema,
}, { additionalProperties: false });
export type AssetRef = Static<typeof AssetRefSchema>;
export type AssetKind = AssetRef["kind"];
export const parseAssetRef = (value: unknown): AssetRef => {
  if (!Check(AssetRefSchema, value)) throw new Error("invalid_asset");
  return value;
};
export function validScope(scope: string): string {
  if (!/^[A-Za-z0-9:_-]{1,240}$/.test(scope)) throw new Error("invalid_scope");
  return scope;
}
export async function sha256(bytes: Uint8Array | string): Promise<string> {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export function cleanFileName(name: string): string {
  return name.replace(/[\\/\p{Cc}]/gu, "_").slice(0, 255) || "attachment";
}
export function imageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((byte, index) => bytes[index] === byte)) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 16));
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
  return undefined;
}
export function safeMime(value: string | undefined): string {
  const mime = value?.split(";")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) ? mime : "application/octet-stream";
}

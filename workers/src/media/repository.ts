import { ASSET_PREFIX, FILE_MAX_BYTES, cleanFileName, imageMime, parseAssetRef, safeMime, sha256, validScope, type AssetKind, type AssetRef } from "./model";
import { downloadMedia, type DownloadDeps } from "./download";
export type { AssetRef, AssetKind } from "./model";

export async function scopePrefix(scope: string): Promise<string> { return `${ASSET_PREFIX}/scopes/${await sha256(validScope(scope))}`; }
export class MediaRepository {
  readonly scope: string;
  private readonly bucket: R2Bucket;
  constructor(options: { bucket: R2Bucket; scope: string }) { this.bucket = options.bucket; this.scope = validScope(options.scope); }
  private async key(id: string): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("invalid_asset");
    return `${await scopePrefix(this.scope)}/assets/${id}`;
  }
  async put(input: { bytes: Uint8Array; name: string; mime?: string; kind?: AssetKind }): Promise<AssetRef> {
    if (input.bytes.byteLength > FILE_MAX_BYTES) throw new Error("too_large");
    const image = imageMime(input.bytes), kind = input.kind ?? (image ? "image" : "file");
    if (kind === "image" && !image) throw new Error("unsupported_image");
    const ref = { scope: this.scope, sha256: await sha256(input.bytes), bytes: input.bytes.byteLength,
      name: cleanFileName(input.name), mime: image ?? safeMime(input.mime), kind };
    const asset: AssetRef = { ...ref, id: await sha256(JSON.stringify(ref)) };
    const key = await this.key(asset.id);
    await this.bucket.put(key, input.bytes, { httpMetadata: { contentType: asset.mime }, customMetadata: { ref: JSON.stringify(asset) } });
    return asset;
  }
  async get(id: string): Promise<{ ref: AssetRef; bytes: Uint8Array }> {
    const object = await this.bucket.get(await this.key(id));
    if (!object || !object.customMetadata?.ref) throw new Error("asset_not_found");
    const ref = parseAssetRef(JSON.parse(object.customMetadata.ref));
    if (ref.scope !== this.scope || ref.id !== id) throw new Error("asset_scope_denied");
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength !== ref.bytes || await sha256(bytes) !== ref.sha256) throw new Error("asset_corrupt");
    return { ref, bytes };
  }
  async importRemote(input: { url?: string; name?: string; kind: AssetKind }, deps?: DownloadDeps): Promise<AssetRef> {
    if (!input.url) throw new Error("media_url_missing");
    const remote = await downloadMedia(input.url, deps);
    return this.put({ bytes: remote.bytes, name: input.name ?? input.kind, mime: remote.mime, kind: input.kind });
  }
  async issueToken(id: string, ttlSeconds = 300): Promise<string> {
    const { ref } = await this.get(id);
    const token = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const expires = Date.now() + Math.max(1, Math.min(600, Math.trunc(ttlSeconds))) * 1000;
    await this.bucket.put(`${ASSET_PREFIX}/tickets/${await sha256(token)}`, JSON.stringify({ ref, expires }), { customMetadata: { expires: String(expires) } });
    return token;
  }
  async issueUrl(id: string, origin: string, ttlSeconds = 300): Promise<string> {
    const url = new URL("/media/object", origin);
    if (url.protocol !== "https:") throw new Error("invalid_media_origin");
    url.searchParams.set("token", await this.issueToken(id, ttlSeconds));
    return url.href;
  }
}
export async function readMediaToken(bucket: R2Bucket, token: string): Promise<{ ref: AssetRef; bytes: Uint8Array }> {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("invalid_media_token");
  const object = await bucket.get(`${ASSET_PREFIX}/tickets/${await sha256(token)}`);
  if (!object) throw new Error("invalid_media_token");
  const value: unknown = await object.json();
  if (!value || typeof value !== "object" || !("expires" in value) || typeof value.expires !== "number" ||
    value.expires <= Date.now() || !("ref" in value)) throw new Error("media_token_expired");
  const ref = parseAssetRef(value.ref);
  return new MediaRepository({ bucket, scope: ref.scope }).get(ref.id);
}

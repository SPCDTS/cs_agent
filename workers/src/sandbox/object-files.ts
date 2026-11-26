import { ASSET_PREFIX, FILE_MAX_BYTES, LEGACY_ASSET_PREFIX } from "../media/model";

const encoder = new TextEncoder();
const TEMP = ".tmp/";
const TEMP_ROOT = `${ASSET_PREFIX}/temporary-files/`;
const LEGACY_TEMP_ROOT = `${LEGACY_ASSET_PREFIX}/temporary-files/`;
const OUTPUT_LIFETIME = 7 * 86400_000;

export function fileKey(value: string): string {
  const key = value.startsWith("r2://") ? value.slice(5) : value;
  if (!key || key.split("/").some(part => !part || part === "." || part === "..") || /[\\\x00-\x1f]/.test(key)) throw new Error("invalid_request");
  return key;
}

export function persistentFileKey(value: string): string {
  const key = fileKey(value);
  if (key.startsWith(TEMP)) throw new Error("invalid_request");
  return key;
}

export function temporaryFileRef(suffix: string, now = Date.now()): string {
  return `r2://${TEMP}${now}/${suffix}`;
}

/** R2 按 key 排序。每轮只列最早一页，资源退役后也会被回收。 */
export async function cleanupTemporaryObjects(bucket: R2Bucket, now: number): Promise<void> {
  const suffix = String(now - OUTPUT_LIFETIME) + "/";
  for (const root of [TEMP_ROOT, LEGACY_TEMP_ROOT]) {
    const cutoff = root + suffix;
    const page = await bucket.list({ prefix: root, limit: 1000 });
    const expired = page.objects.filter(object => object.key < cutoff);
    if (expired.length) await bucket.delete(expired.map(object => object.key));
  }
}

/** 前缀由宿主工作区身份决定，模型只能指定其中的对象 key。 */
export class ObjectFiles {
  constructor(private bucket: R2Bucket, private scope: string) {}
  private objectKey(value: string, prefix = ASSET_PREFIX): string {
    const key = fileKey(value);
    let full = `${prefix}/object-files/${this.scope}/${key}`;
    if (key.startsWith(TEMP)) {
      const match = /^\.tmp\/(\d{13})\/(.+)$/s.exec(key);
      if (!match) throw new Error("invalid_request");
      full = `${prefix}/temporary-files/${match[1]}/${this.scope}/${match[2]}`;
    }
    if (encoder.encode(full).length > 1024) throw new Error("invalid_request");
    return full;
  }
  async read(key: string): Promise<Uint8Array> {
    const object = await this.bucket.get(this.objectKey(key))
      ?? await this.bucket.get(this.objectKey(key, LEGACY_ASSET_PREFIX));
    if (!object) throw new Error("not_found");
    if (object.size > FILE_MAX_BYTES) throw new Error("too_large");
    return new Uint8Array(await object.arrayBuffer());
  }
  async write(key: string, content: string | Uint8Array): Promise<{ bytes: number }> {
    const data = typeof content === "string" ? encoder.encode(content) : content;
    if (data.byteLength > FILE_MAX_BYTES) throw new Error("too_large");
    await this.bucket.put(this.objectKey(key), data);
    return { bytes: data.byteLength };
  }
  outputPrefix(prefix: string, now = Date.now()): string {
    if (!/^[a-zA-Z0-9_-]{0,64}$/.test(prefix)) throw new Error("invalid_request");
    return temporaryFileRef(`codemode/${crypto.randomUUID()}-${prefix}`, now);
  }
}

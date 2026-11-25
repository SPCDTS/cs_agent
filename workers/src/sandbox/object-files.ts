import { FILE_MAX_BYTES } from "../media/model";

const encoder = new TextEncoder();
const OUTPUT_PREFIX = ".codemode/";
const OUTPUT_LIFETIME = 7 * 86400_000;

export function fileKey(value: string): string {
  const key = value.startsWith("r2://") ? value.slice(5) : value;
  if (!key || key.split("/").some(part => !part || part === "." || part === "..") || /[\\\x00-\x1f]/.test(key)) throw new Error("invalid_request");
  return key;
}

/** 前缀由宿主工作区身份决定，模型只能指定其中的对象 key。 */
export class ObjectFiles {
  constructor(private bucket: R2Bucket, private prefix: string) {}
  private objectKey(key: string): string {
    const full = this.prefix + fileKey(key);
    if (encoder.encode(full).length > 1024) throw new Error("invalid_request");
    return full;
  }
  async read(key: string): Promise<Uint8Array> {
    const object = await this.bucket.get(this.objectKey(key));
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
    return `r2://${OUTPUT_PREFIX}${now}-${crypto.randomUUID()}-${prefix}`;
  }
  private nextCleanup = 0;
  async cleanupOutputs(now: number): Promise<void> {
    if (now < this.nextCleanup) return;
    this.nextCleanup = now + 60 * 60_000;
    const page = await this.bucket.list({ prefix: this.prefix + OUTPUT_PREFIX, limit: 100 });
    const expired = page.objects.filter(object => object.uploaded.getTime() < now - OUTPUT_LIFETIME);
    if (expired.length) await this.bucket.delete(expired.map(object => object.key));
  }
}

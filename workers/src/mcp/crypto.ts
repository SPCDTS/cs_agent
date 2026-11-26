import { OAuthFailure } from "./oauth-fetch";
import { sha256Bytes } from "../shared/hash";

export const randomSecret = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
export const sha256 = async (value: string) => sha256Bytes(value);
const BYTES_MAGIC = new TextEncoder().encode("CSENC1");
const encoder = new TextEncoder();

export class TokenVault {
  readonly configured: boolean;
  private key?: Promise<CryptoKey>;
  constructor(private readonly secret?: string) { this.configured = !!secret && /^[a-f\d]{64}$/i.test(secret); }
  private getKey(): Promise<CryptoKey> {
    if (!this.configured || !this.secret) throw new OAuthFailure("unconfigured");
    return this.key ??= crypto.subtle.importKey("raw", Buffer.from(this.secret, "hex"), "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  async encrypt(value: string, identity: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    // AAD 把密文绑定到账号版本和字段，不能把其他行的 refresh token 移植到此账号。
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(identity) }, await this.getKey(), encoder.encode(value));
    return `v1.${Buffer.from(iv).toString("base64url")}.${Buffer.from(ciphertext).toString("base64url")}`;
  }
  async decrypt(value: string, identity: string): Promise<string> {
    try {
      const [version, nonce, data, extra] = value.split(".");
      if (version !== "v1" || !nonce || !data || extra !== undefined) throw new Error();
      const iv = Buffer.from(nonce, "base64url");
      if (iv.length !== 12) throw new Error();
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv,
        additionalData: encoder.encode(identity) }, await this.getKey(), Buffer.from(data, "base64url")));
    } catch { throw new OAuthFailure("oauth_token"); }
  }
  async encryptBytes(value: Uint8Array, identity: string): Promise<Uint8Array> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(identity) },
      await this.getKey(),
      Uint8Array.from(value),
    ));
    const out = new Uint8Array(BYTES_MAGIC.length + iv.length + ciphertext.length);
    out.set(BYTES_MAGIC, 0);
    out.set(iv, BYTES_MAGIC.length);
    out.set(ciphertext, BYTES_MAGIC.length + iv.length);
    return out;
  }
  async decryptBytes(value: Uint8Array, identity: string): Promise<Uint8Array> {
    try {
      if (value.byteLength < BYTES_MAGIC.length + 12 + 16) throw new Error();
      for (let i = 0; i < BYTES_MAGIC.length; i++) if (value[i] !== BYTES_MAGIC[i]) throw new Error();
      const iv = Uint8Array.from(value.subarray(BYTES_MAGIC.length, BYTES_MAGIC.length + 12));
      const data = Uint8Array.from(value.subarray(BYTES_MAGIC.length + 12));
      return new Uint8Array(await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: encoder.encode(identity) },
        await this.getKey(),
        data,
      ));
    } catch { throw new OAuthFailure("oauth_token"); }
  }
}

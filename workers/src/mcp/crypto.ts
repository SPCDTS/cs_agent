import { createDecipheriv } from "node:crypto";
import { OAuthFailure } from "./oauth-fetch";
import { sha256Bytes } from "../shared/hash";

export const randomSecret = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
export const sha256 = async (value: string) => sha256Bytes(value);

export class TokenVault {
  readonly configured: boolean;
  private key?: Promise<CryptoKey>;
  constructor(private readonly secret?: string) { this.configured = !!secret && /^[a-f\d]{64}$/i.test(secret); }
  /** 升级旧 SQL 密文时同步解密，使内容与迁移标记可在一个 SQLite 事务提交。 */
  legacyValue(value: string, identity: string): string {
    if (!this.configured || !this.secret) throw new OAuthFailure("unconfigured");
    try {
      const [version, nonce, raw, extra] = value.split(".");
      if (version !== "v1" || !nonce || !raw || extra !== undefined) throw new Error();
      const ciphertext = Buffer.from(raw, "base64url");
      const cipher = createDecipheriv("aes-256-gcm", Buffer.from(this.secret, "hex"), Buffer.from(nonce, "base64url"));
      cipher.setAAD(Buffer.from(identity));
      cipher.setAuthTag(ciphertext.subarray(-16));
      return Buffer.concat([cipher.update(ciphertext.subarray(0, -16)), cipher.final()]).toString("utf8");
    } catch {
      throw new OAuthFailure("oauth_token");
    }
  }

  private getKey(): Promise<CryptoKey> {
    if (!this.configured || !this.secret) throw new OAuthFailure("unconfigured");
    return this.key ??= crypto.subtle.importKey("raw", Buffer.from(this.secret, "hex"), "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  async encrypt(value: string, identity: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    // AAD 把密文绑定到账号版本和字段，不能把其他行的 refresh token 移植到此账号。
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(identity) }, await this.getKey(), new TextEncoder().encode(value));
    return `v1.${Buffer.from(iv).toString("base64url")}.${Buffer.from(ciphertext).toString("base64url")}`;
  }
  async decrypt(value: string, identity: string): Promise<string> {
    try {
      const [version, nonce, data, extra] = value.split(".");
      if (version !== "v1" || !nonce || !data || extra !== undefined) throw new Error();
      const iv = Buffer.from(nonce, "base64url");
      if (iv.length !== 12) throw new Error();
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv,
        additionalData: new TextEncoder().encode(identity) }, await this.getKey(), Buffer.from(data, "base64url")));
    } catch { throw new OAuthFailure("oauth_token"); }
  }
}

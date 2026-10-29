import { OAuthFailure } from "./oauth-fetch";

export const randomSecret = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
export const sha256 = async (value: string) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));

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

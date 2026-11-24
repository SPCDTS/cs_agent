import { Check } from "typebox/value";
import { TokenVault } from "../mcp/crypto";
import { readBoundedText } from "../shared/http-body";
import { Binding, boundMaterial, cookieEchoNeedle, endpoint, Group, outbound, Ref, type Material } from "./material";

export const SHARED_CREDENTIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS shared_credentials(ref TEXT PRIMARY KEY, binding TEXT NOT NULL, revision TEXT NOT NULL, encrypted TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS shared_credential_groups(ref TEXT NOT NULL, scope TEXT NOT NULL, PRIMARY KEY(ref, scope));
CREATE INDEX IF NOT EXISTS shared_credentials_by_scope ON shared_credential_groups(scope, ref);`;
export type WriteCredential = { ref: string; binding: Binding } | { ref: string; expectedRevision: string };
type Entry = { ref: string; binding: string; revision: string };
const identity = (ref: string, revision: string) => JSON.stringify(["shared-http-credential", ref, revision]);

// 响应不回传认证头、Cookie 或重定向地址。发现上游回显值时丢弃整个正文。
function echoed(text: string, values: string[]) {
  return values.some(value => {
    if (text.includes(value) || text.includes(encodeURIComponent(value)) || text.includes(JSON.stringify(value).slice(1, -1))) return true;
    try { return text.includes(decodeURIComponent(value)); } catch { return false; }
  });
}

// 删除 Cookie 时常见的占位值会与业务正文重合。有效期明确的删除指令优先于名称判断。
function responseCookieNeedle(field: string, binding: Binding): string | undefined {
  const [pair = "", ...attributes] = field.split(";");
  const equal = pair.indexOf("="), name = pair.slice(0, equal).trim(), value = pair.slice(equal + 1).trim();
  if (equal < 1 || !value) return;
  if (/^(?:deleted|0|false)$/i.test(value)) {
    const age = attributes.map(a => a.trim()).find(a => /^max-age=-?\d+$/i.test(a));
    const expires = attributes.map(a => a.trim()).find(a => /^expires=/i.test(a));
    const cleared = age ? Number(age.slice(8)) <= 0 : !!expires && Date.parse(expires.slice(8)) <= Date.now();
    if (cleared || value === "deleted" && !binding.cookieNames?.includes(name)) return name + "=" + value;
  }
  return cookieEchoNeedle(name, value, binding);
}

export class SharedCredentials {
  private active = 0;
  constructor(private readonly sql: SqlStorage, private readonly vault: TokenVault) {}

  private entry(ref: string) {
    return this.sql.exec<Entry>("SELECT ref,binding,revision FROM shared_credentials WHERE ref=?", ref).toArray()[0];
  }

  list(scope: string) {
    if (scope !== "owner") {
      return this.sql.exec<Entry>("SELECT c.ref,binding FROM shared_credentials c JOIN shared_credential_groups g ON c.ref=g.ref WHERE g.scope=? ORDER BY c.ref", scope)
        .toArray().map(row => ({ ref: row.ref, ...JSON.parse(row.binding) as Binding }));
    }
    const grants = new Map<string, string[]>();
    for (const row of this.sql.exec<{ ref: string; scope: string }>("SELECT ref,scope FROM shared_credential_groups ORDER BY ref,scope")) {
      const groups = grants.get(row.ref) ?? [];
      groups.push(row.scope);
      grants.set(row.ref, groups);
    }
    return this.sql.exec<Entry>("SELECT ref,binding,revision FROM shared_credentials ORDER BY ref").toArray()
      .map(row => ({ ref: row.ref, ...JSON.parse(row.binding) as Binding, revision: row.revision, groups: grants.get(row.ref) ?? [] }));
  }

  async save(change: WriteCredential, bytes: Uint8Array) {
    if (!Check(Ref, change.ref)) throw new Error("credential_invalid_ref");
    const existing = this.entry(change.ref);
    const create = "binding" in change;
    if (create ? !!existing : !existing || existing.revision !== change.expectedRevision) throw new Error("credential_conflict");
    const binding: Binding = create ? change.binding : JSON.parse(existing!.binding);
    if (!Check(Binding, binding) || binding.header && binding.kind !== "api-key" || binding.cookieNames && binding.kind !== "cookie") throw new Error("credential_invalid_binding");
    const endpoints = binding.endpoints.map(raw => {
      const url = endpoint(raw);
      if (url.href.includes("?") || url.pathname.includes("*") && url.pathname !== "/*") throw new Error("credential_invalid_binding");
      return url.href;
    });
    const policy = JSON.stringify({ ...binding, endpoints });
    const material = boundMaterial(bytes, binding);
    const revision = crypto.randomUUID();
    const encrypted = await this.vault.encrypt(JSON.stringify(material), identity(change.ref, revision));
    // 加密期间可能发生另一笔写入。创建与轮换都以写入时的版本为准，轮换保留独立的授权记录。
    if (create && this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM shared_credentials").one().count >= 64) throw new Error("credential_limit");
    const writes = create
      ? this.sql.exec("INSERT OR IGNORE INTO shared_credentials(ref,binding,revision,encrypted) VALUES(?,?,?,?)", change.ref, policy, revision, encrypted)
      : this.sql.exec("UPDATE shared_credentials SET revision=?,encrypted=? WHERE ref=? AND revision=?", revision, encrypted, change.ref, change.expectedRevision);
    if (!writes.rowsWritten) throw new Error("credential_conflict");
    return { ref: change.ref, revision };
  }

  forget(ref: string, revision: string) {
    if (!this.sql.exec("DELETE FROM shared_credentials WHERE ref=? AND revision=?", ref, revision).rowsWritten) throw new Error("credential_conflict");
    this.sql.exec("DELETE FROM shared_credential_groups WHERE ref=?", ref);
    return { ref, removed: true };
  }

  share(ref: string, group: string, allow: boolean) {
    if (!Check(Group, group) || !this.entry(ref)) throw new Error("credential_invalid_grant");
    if (allow) {
      const groupCount = this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM shared_credential_groups WHERE ref=? AND scope<>?", ref, group).one().count;
      if (groupCount >= 64) throw new Error("credential_limit");
      this.sql.exec("INSERT OR IGNORE INTO shared_credential_groups VALUES(?,?)", ref, group);
    } else this.sql.exec("DELETE FROM shared_credential_groups WHERE ref=? AND scope=?", ref, group);
    return { ref, group, allowed: allow };
  }

  private allowed(scope: string, ref: string) {
    return scope === "owner" || this.sql.exec("SELECT 1 FROM shared_credential_groups WHERE ref=? AND scope=?", ref, scope).toArray().length > 0;
  }

  async request(scope: string, ref: string, raw: string, needsLogin: (revision: string) => void) {
    if (!this.allowed(scope, ref)) throw new Error("credential_denied");
    const row = this.sql.exec<Entry & { encrypted: string }>("SELECT * FROM shared_credentials WHERE ref=?", ref).toArray()[0];
    if (!row) throw new Error("credential_denied");
    const binding: Binding = JSON.parse(row.binding);
    const url = endpoint(raw);
    const trusted = binding.endpoints.includes(url.origin + url.pathname) || binding.endpoints.includes(url.origin + "/*");
    if (!trusted || raw.length > 4096) throw new Error("credential_target_denied");
    if (this.active >= 8) throw new Error("credential_busy");
    this.active++;
    const current = () => this.entry(ref)?.revision === row.revision && this.allowed(scope, ref);
    try {
      const material: Material = JSON.parse(await this.vault.decrypt(row.encrypted, identity(ref, row.revision)));
      if (!current()) throw new Error("credential_denied");
      const auth = outbound(material, binding, url);
      const response = await fetch(url.href, { method: "GET", headers: { [auth.name]: auth.value },
        redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401) throw new Error("credential_login_required");
        if (response.status >= 300 && response.status < 400) throw new Error("credential_redirect_denied");
        return { status: response.status };
      }
      const mime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (response.status !== 204 && !(mime?.startsWith("text/") || mime === "application/json" || mime?.endsWith("+json"))) {
        await response.body?.cancel();
        throw new Error("credential_response_type");
      }
      const body = await readBoundedText(response, { maxBytes: 64 * 1024, timeoutMs: 10_000, fatal: true });
      if (!current()) throw new Error("credential_denied");
      const sensitive = [...auth.sensitive];
      const freshCookies = response.headers.getSetCookie();
      if (freshCookies.length > 64) throw new Error("credential_response_withheld");
      for (const field of freshCookies) {
        const needle = responseCookieNeedle(field, binding);
        if (needle) sensitive.push(needle);
      }
      if (echoed(body, sensitive)) throw new Error("credential_response_withheld");
      // JSON 转义后的字符串会被脚本解码，按同一边界再检查一次。
      if (body && (mime === "application/json" || mime?.endsWith("+json"))) {
        if (echoed(JSON.stringify(JSON.parse(body)), sensitive)) throw new Error("credential_response_withheld");
      }
      return { status: response.status, body };
    } catch (error) {
      if (error instanceof Error && ["credential_login_required", "credential_cookie_unavailable"].includes(error.message) && current()) needsLogin(row.revision);
      if (error instanceof Error && /^credential_[a-z_]+$/.test(error.message)) throw error;
      throw new Error("credential_request_failed");
    } finally { this.active--; }
  }
}

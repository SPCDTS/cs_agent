import { Type, type Static } from "typebox";
import { checkUrl } from "../tools/web-page";

export const FILE_LIMIT = 16 * 1024;
export const Ref = Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" });
export const Group = Type.String({ pattern: "^group:[1-9][0-9]{0,19}$" });
export const Binding = Type.Object({
  kind: Type.Union([Type.Literal("cookie"), Type.Literal("bearer"), Type.Literal("api-key")]),
  endpoints: Type.Array(Type.String({ maxLength: 1024 }), { minItems: 1, maxItems: 12, uniqueItems: true,
    description: "受信任的 HTTPS 查询地址，不含查询串。默认精确路径；主人明确授权整域时可用 https://host/*。" }),
  cookieNames: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: 32, uniqueItems: true,
    description: "可选，只导入该服务登录所需的 Cookie 名，忽略同站偏好设置。" })),
  header: Type.Optional(Type.String({ pattern: "^[xX]-[A-Za-z0-9-]{1,60}$", description: "api-key 专用，默认 X-API-Key。" })),
}, { additionalProperties: false });
export type Binding = Static<typeof Binding>;

export function endpoint(raw: string): URL {
  let url: URL;
  try { url = checkUrl(raw); } catch { throw new Error("credential_target_denied"); }
  if (url.protocol !== "https:" || url.href.includes("#") || url.hostname.endsWith(".") || raw.includes("\\"))
    throw new Error("credential_target_denied");
  return url;
}

type Cookie = { name: string; value: string; domain?: string; subdomains?: boolean; path?: string; expires?: number };
export type Material = { token: string } | { cookies: Cookie[] };

function validateCookie({ name, value }: Cookie): void {
  if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || !/^[\x21-\x3a\x3c-\x7e]*$/.test(value)) throw new Error("credential_invalid_file");
}

function parseMaterial(input: Uint8Array, kind: Binding["kind"], selected: (c: Cookie) => boolean): Material {
  if (!input.length || input.length > FILE_LIMIT) throw new Error("credential_file_size");
  let raw: string;
  try { raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(input).replace(/(?:\r?\n)+$/, ""); }
  catch { throw new Error("credential_invalid_file"); }
  if (kind !== "cookie") {
    const token = raw.trim();
    if (!/^[!-~]+$/.test(token)) throw new Error("credential_invalid_file");
    return { token };
  }
  const cookies: Cookie[] = [];
  if (raw.includes("\t") || raw.startsWith("#")) {
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.startsWith("#") && !line.startsWith("#HttpOnly_")) continue;
      const fields = line.replace(/^#HttpOnly_/, "").split("\t");
      const [domain, subs = "", path, secure = "", expiry = "", name = "", value = ""] = fields;
      const record: Cookie = { name, value, domain: domain?.replace(/^\./, "").toLowerCase(), subdomains: subs === "TRUE", path,
        expires: /^\d{1,12}$/.test(expiry) ? Number(expiry) : undefined };
      if (!selected(record)) continue;
      if (fields.length !== 7 || !domain || !/^\.?[a-z\d-]+(?:\.[a-z\d-]+)*$/i.test(domain) || !path?.startsWith("/")
        || !/^(TRUE|FALSE)$/.test(subs) || !/^(TRUE|FALSE)$/.test(secure) || record.expires === undefined) throw new Error("credential_invalid_file");
      validateCookie(record);
      cookies.push(record);
    }
  } else {
    for (const field of raw.replace(/^Cookie:[ \t]*/i, "").split(";")) {
      const pair = field.replace(/^ +| +$/g, ""), equals = pair.indexOf("=");
      const record = { name: equals < 0 ? pair : pair.slice(0, equals), value: pair.slice(equals + 1) };
      if (!selected(record)) continue;
      if (equals < 1) throw new Error("credential_invalid_file");
      validateCookie(record);
      cookies.push(record);
    }
  }
  if (cookies.length > 128) throw new Error("credential_invalid_file");
  return { cookies };
}

function matchesScope(c: Cookie, target: URL, wholeOrigin = false): boolean {
  if (!c.domain) return true;
  const domainMatches = target.hostname === c.domain || !!c.subdomains && target.hostname.endsWith("." + c.domain);
  const pathMatches = !c.path || target.pathname === c.path || target.pathname.startsWith(c.path.endsWith("/") ? c.path : c.path + "/");
  return domainMatches && (wholeOrigin || pathMatches);
}

const unexpired = (c: Cookie) => !c.expires || c.expires > Date.now() / 1000;

/** 浏览器导出的文件可能包含多个站点，只接管允许的查询可使用的条目。 */
export function boundMaterial(bytes: Uint8Array, binding: Binding): Material {
  const targets = binding.endpoints.map(raw => new URL(raw));
  const applies = (c: Cookie, target: URL) => matchesScope(c, target, target.pathname === "/*");
  const material = parseMaterial(bytes, binding.kind, c => unexpired(c) && (!binding.cookieNames || binding.cookieNames.includes(c.name))
    && targets.some(target => applies(c, target)));
  if ("token" in material) return material;
  const { cookies } = material;
  if (binding.cookieNames?.some(name => !cookies.some(c => c.name === name))
    || targets.some(target => !cookies.some(c => applies(c, target)))) throw new Error("credential_cookie_unavailable");
  return material;
}

// 偏好值 1、en 等可正常出现在业务数据中，只检查这些 Cookie 的完整名值对。
// 未知名称及主人显式选中的凭证继续检查裸值，包括很短的会话凭证。
export function cookieEchoNeedle(name: string, value: string, binding: Binding): string {
  const pair = name + "=" + value;
  if (binding.cookieNames?.includes(name)) return value;
  if (/^(?:lang(?:uage)?|locale|region|country(?:_code)?|currency)$/i.test(name)
    && /^[a-z]{2,3}(?:[-_][a-z]{2,4})?$/i.test(value)) return pair;
  if (/^(?:flag|pref|logged_?in|wants_mature_content|enabled|opt_?in)$/i.test(name)
    && /^(?:0|1|true|false|yes|no|on|off)$/i.test(value)) return pair;
  if (/^(?:v|version)$/i.test(name) && /^\d{1,3}$/.test(value)) return pair;
  return value;
}

export function outbound(material: Material, binding: Binding, target: URL) {
  if ("token" in material) {
    const bearer = binding.kind === "bearer";
    return { name: bearer ? "Authorization" : binding.header ?? "X-API-Key",
      value: bearer ? "Bearer " + material.token : material.token, sensitive: [material.token] };
  }
  const eligible = material.cookies.filter(c => matchesScope(c, target));
  if (!eligible.length) throw new Error("credential_cookie_scope");
  const selected = eligible.filter(unexpired).sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0));
  if (!selected.length) throw new Error("credential_cookie_unavailable");
  return { name: "Cookie", value: selected.map(c => c.name + "=" + c.value).join("; "), sensitive: selected.filter(c => c.value).map(c => cookieEchoNeedle(c.name, c.value, binding)) };
}

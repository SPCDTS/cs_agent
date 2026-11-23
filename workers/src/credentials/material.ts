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

function cookie(name: string, value: string): Cookie {
  if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || !/^[\x21-\x2b\x2d-\x3a\x3c-\x7e]*$/.test(value)) throw new Error("credential_invalid_file");
  return { name, value };
}

export function parseMaterial(input: Uint8Array, kind: Binding["kind"]): Material {
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
      if (fields.length !== 7 || !domain || !/^\.?[a-z\d-]+(?:\.[a-z\d-]+)*$/i.test(domain) || !path?.startsWith("/")
        || !/^(TRUE|FALSE)$/.test(subs) || !/^(TRUE|FALSE)$/.test(secure) || !/^\d{1,12}$/.test(expiry)) throw new Error("credential_invalid_file");
      cookies.push({ ...cookie(name, value), domain: domain.replace(/^\./, "").toLowerCase(), subdomains: subs === "TRUE", path, expires: Number(expiry) });
    }
  } else {
    for (const field of raw.replace(/^Cookie:\s*/i, "").split(";")) {
      const pair = field.trim(), equals = pair.indexOf("=");
      if (equals < 1) throw new Error("credential_invalid_file");
      cookies.push(cookie(pair.slice(0, equals), pair.slice(equals + 1)));
    }
  }
  if (!cookies.length || cookies.length > 128) throw new Error("credential_invalid_file");
  return { cookies };
}

function matchesScope(c: Cookie, target: URL, wholeOrigin = false): boolean {
  if (!c.domain || !c.path) return true;
  const domainMatches = target.hostname === c.domain || !!c.subdomains && target.hostname.endsWith("." + c.domain);
  const pathMatches = target.pathname === c.path || target.pathname.startsWith(c.path.endsWith("/") ? c.path : c.path + "/");
  return domainMatches && (wholeOrigin || pathMatches);
}

const unexpired = (c: Cookie) => !c.expires || c.expires > Date.now() / 1000;

/** 浏览器导出的文件可能包含多个站点，只接管允许的查询可使用的条目。 */
export function boundMaterial(bytes: Uint8Array, binding: Binding): Material {
  const material = parseMaterial(bytes, binding.kind);
  if ("token" in material) return material;
  const targets = binding.endpoints.map(raw => new URL(raw));
  const applies = (c: Cookie, target: URL) => matchesScope(c, target, target.pathname === "/*");
  const cookies = material.cookies.filter(c => unexpired(c) && (!binding.cookieNames || binding.cookieNames.includes(c.name))
    && targets.some(target => applies(c, target)));
  if (binding.cookieNames?.some(name => !cookies.some(c => c.name === name))
    || targets.some(target => !cookies.some(c => applies(c, target)))) throw new Error("credential_cookie_unavailable");
  return { cookies };
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
  return { name: "Cookie", value: selected.map(c => c.name + "=" + c.value).join("; "), sensitive: selected.map(c => c.value).filter(Boolean) };
}

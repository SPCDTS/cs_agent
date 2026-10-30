import type { Resource, ResourceTemplate } from "@modelcontextprotocol/sdk/types.js";

/** URI 只交回已配置的服务；不把目录里的链接当成可任意联网的 URL。 */
export function allowedResource(uri: string, prefixes: readonly string[]): boolean {
  if (uri.length > 4096 || /[\x00-\x20\x7f]/.test(uri) || !prefixes.some(prefix => uri.startsWith(prefix))) return false;
  try {
    const parsed = new URL(uri);
    return !parsed.username && !parsed.password && !parsed.hash && !decodeURIComponent(uri).split(/[/?#]/).some(part => part === ".." || part === ".");
  } catch { return false; }
}
const escape = (value: string) => value.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
export function resourceInCatalog(uri: string, resources: readonly Resource[], templates: readonly ResourceTemplate[]): boolean {
  if (resources.some(resource => resource.uri === uri)) return true;
  return templates.some(template => {
    const parts = template.uriTemplate.split(/(\{[^}]+\})/g);
    const pattern = parts.map(part => /^\{\+/.test(part) ? "[^?#]+" : /^\{[^}]+\}$/.test(part) ? "[^/?#]+" : escape(part)).join("");
    return new RegExp("^" + pattern + "$").test(uri);
  });
}

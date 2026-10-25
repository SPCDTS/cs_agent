import { readFile } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { posix } from "node:path";
import { z } from "zod";

const limit = (value: number, max: number) => z.number().int().min(1).max(max).default(value);
const limitsSchema = z.strictObject({
  connectMs: limit(10_000, 60_000), callMs: limit(60_000, 300_000),
  connections: limit(16, 64), queuedPerConnection: limit(16, 64),
  idleMs: limit(300_000, 3_600_000), catalogTtlMs: limit(300_000, 3_600_000),
  maxPages: limit(20, 100), maxTools: limit(200, 1_000), catalogBytes: limit(2_097_152, 8_388_608),
  schemaBytes: limit(65_536, 262_144), schemaDepth: limit(64, 64),
  visibleTools: limit(64, 128), visibleSchemaBytes: limit(524_288, 2_097_152),
  argumentBytes: limit(262_144, 1_048_576), messageBytes: limit(12_582_912, 25_165_824),
  textBytes: limit(32_768, 131_072), structuredBytes: limit(262_144, 1_048_576),
  imageBytes: limit(5_242_880, 10_485_760), contentBytes: limit(8_388_608, 20_971_520),
  images: z.number().int().min(0).max(4).default(2),
  retainedRevisions: limit(128, 512), retainedCatalogBytes: limit(33_554_432, 134_217_728),
  closePerConnectionMs: limit(3_000, 10_000), closeTotalMs: limit(10_000, 30_000),
});
export type McpLimits = z.infer<typeof limitsSchema>;
export const DEFAULT_MCP_LIMITS: McpLimits = Object.freeze(limitsSchema.parse({}));

const cleanText = z.string().max(8_192).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
const variable = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u);
const absolutePath = cleanText.min(1).refine(value => posix.isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\[^\\]+\\[^\\]+\\/u.test(value));
const workspace = "${sessionWorkspace}";
const argument = cleanText.refine(value => value === workspace || !value.includes("${"));
const environment = z.record(variable, cleanText);
const secretEnvironment = z.record(variable, variable);
const headerName = z.string().max(128).regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u);
const sensitiveHeader = /(?:^|[-_])(?:auth|authorization|cookie|token|key|secret)(?:$|[-_])/iu;
const reservedHeader = /^(accept|content-type|host|content-length|connection|transfer-encoding|upgrade|te|trailer|keep-alive|mcp-.*|last-event-id|proxy-.*|sec-.*)$/iu;

const stdioSchema = z.strictObject({
  kind: z.literal("stdio"), command: absolutePath.refine(value => !value.includes("${")),
  args: z.array(argument).max(128).default([]),
  cwd: z.union([z.literal(workspace), absolutePath.refine(value => !value.includes("${"))]),
  inheritEnv: z.array(variable).max(128).default([]),
  env: environment.default({}), secretEnv: secretEnvironment.default({}),
  execution: z.literal("trusted-host"),
}).superRefine((value, ctx) => {
  const names = [...value.inheritEnv, ...Object.keys(value.env), ...Object.keys(value.secretEnv)].map(name => name.toUpperCase());
  if (new Set(names).size !== names.length) ctx.addIssue({ code: "custom", path: ["env"], message: "环境变量重复" });
});
const httpSchema = z.strictObject({
  kind: z.literal("streamable-http"), url: cleanText.min(1).max(4_096),
  headers: z.record(headerName, cleanText).default({}),
  secretHeaders: z.record(headerName, variable).default({}), allowLoopbackHttp: z.boolean().default(false),
  allowPrivateNetworkHttp: z.boolean().default(false),
}).superRefine((value, ctx) => {
  try {
    const url = new URL(value.url);
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.[0-9]{1,3}){3}$/u.test(url.hostname);
    const [first, second] = url.hostname.split(".").map(Number);
    const privateNetwork = isIPv4(url.hostname) && (first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168));
    const allowedHttp = url.protocol === "http:" && ((value.allowLoopbackHttp && loopback) || (value.allowPrivateNetworkHttp && privateNetwork));
    if (url.username || url.password || url.hash || (url.protocol !== "https:" && !allowedHttp)) {
      ctx.addIssue({ code: "custom", path: ["url"], message: "传输地址不允许" });
    }
  } catch {
    ctx.addIssue({ code: "custom", path: ["url"], message: "传输地址无效" });
  }
  const names = [...Object.keys(value.headers), ...Object.keys(value.secretHeaders)].map(name => name.toLowerCase());
  if (new Set(names).size !== names.length || names.some(name => reservedHeader.test(name)) || Object.keys(value.headers).some(name => sensitiveHeader.test(name))) {
    ctx.addIssue({ code: "custom", path: ["headers"], message: "请求头不允许或重复" });
  }
});
const serverSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u), enabled: z.boolean().default(true),
  transport: z.discriminatedUnion("kind", [stdioSchema, httpSchema]),
  credential: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("none") }),
    z.strictObject({ kind: z.literal("external-account"), accountId: cleanText.min(1).max(128), revision: cleanText.min(1).max(128) }),
  ]),
  tools: z.strictObject({ allow: z.array(cleanText.min(1).max(256)).max(1_000).refine(value => new Set(value).size === value.length) }),
  access: z.strictObject({ kind: z.literal("owner-private"), allowScheduled: z.boolean().default(false), allowWake: z.boolean().default(false) }),
  replay: z.literal("unsafe"),
});
const configSchema = z.strictObject({
  version: z.literal(1), enabled: z.boolean(), servers: z.array(serverSchema).max(64),
  limits: limitsSchema.default(() => ({ ...DEFAULT_MCP_LIMITS })),
}).superRefine((value, ctx) => {
  if (new Set(value.servers.map(server => server.id)).size !== value.servers.length) {
    ctx.addIssue({ code: "custom", path: ["servers"], message: "服务标识重复" });
  }
});
export type McpServerConfig = z.infer<typeof serverSchema>;
export type McpConfig = z.infer<typeof configSchema>;
export type McpConfigState =
  | { kind: "enabled"; value: McpConfig }
  | { kind: "disabled"; reason: string }
  | { kind: "invalid"; issues: readonly { path: string; code: string; message: string }[] };
export interface EnvironmentSecrets {
  readReferencedVariable(name: string): string | undefined;
}

/** 配置错误只返回位置与类别，不回显配置值或 Zod 的原始错误。 */
export function parseMcpConfig(input: unknown): McpConfigState {
  try {
    const parsed = configSchema.safeParse(input);
    if (!parsed.success) return {
      kind: "invalid",
      issues: parsed.error.issues.slice(0, 32).map(issue => ({
        path: issue.path.map(part => typeof part === "number" ? String(part) : String(part).replace(/[^A-Za-z0-9_-]/gu, "*").slice(0, 64)).join("."),
        code: issue.code, message: "MCP 配置不符合契约",
      })),
    };
    return parsed.data.enabled ? { kind: "enabled", value: parsed.data } : { kind: "disabled", reason: "MCP 配置已禁用" };
  } catch {
    return { kind: "invalid", issues: [{ path: "", code: "config_invalid", message: "MCP 配置无法安全解析" }] };
  }
}

/** 读取管理员指定的 UTF-8 文件；损坏或无法读取时禁止新调用。 */
export async function loadMcpConfig(file?: string): Promise<McpConfigState> {
  if (!file) return { kind: "disabled", reason: "未设置 PI_MCP_CONFIG" };
  try {
    const bytes = await readFile(file);
    if (bytes.byteLength > 1_048_576) throw new Error("config_size");
    return parseMcpConfig(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch {
    return { kind: "invalid", issues: [{ path: "", code: "config_unreadable", message: "MCP 配置文件无法读取、超限或不是有效 UTF-8 JSON" }] };
  }
}

import { renderToolSignature, toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations";
import type { Message } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools, normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { Agent, Extension, ToolNamespace, ToolRegistration } from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME } from "@earendil-works/pi-durable/codemode";
import { sha256Hex } from "../shared/hash";
import type { CodemodeCatalogSummary, CodemodeNamespaceItem, CodemodeToolItem } from "./context-types";
import { safeText } from "./snapshot";

type CodemodeJsonSchema = NonNullable<Parameters<typeof renderToolSignature>[0]["inputSchema"]>;

export type StoredCodemodeCatalog = {
  summary: CodemodeCatalogSummary;
  truncated: boolean;
  namespaces: CodemodeNamespaceItem[];
  tools: CodemodeToolItem[];
};

export const MAX_CODEMODE_CATALOG_BYTES = 512 * 1024;
export const MAX_CODEMODE_CATALOGS = 64;
const MAX_CATALOG_TOOLS = 256;
const SOFT_CATALOG_BYTES = 460 * 1024;
const TEXT_OUTPUT_SCHEMA: CodemodeJsonSchema = { type: "string" };
const CODEMODE_INTERNAL_PREFIX = "__pi_codemode_";

function boundedField(raw: string, limit: number): { text: string; truncated: boolean } {
  const clean = safeText(raw);
  return { text: clean.slice(0, limit), truncated: clean.length > limit };
}

function resolveNamespaces(extensions: readonly Pick<Extension, "namespace" | "tools">[]): {
  declared: ToolNamespace[];
  byTool: Map<string, ToolNamespace>;
} {
  const byName = new Map<string, ToolNamespace>();
  const byTool = new Map<string, ToolNamespace>();
  const seenTools = new Set<string>();
  for (const extension of extensions) {
    if (extension.namespace && !byName.has(extension.namespace.name)) {
      byName.set(extension.namespace.name, extension.namespace);
    }
    for (const tool of extension.tools ?? []) {
      if (seenTools.has(tool.name)) continue;
      seenTools.add(tool.name);
      if (extension.namespace) byTool.set(tool.name, extension.namespace);
    }
  }
  return {
    declared: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    byTool,
  };
}

export function inlineCodemodeHeadings(systemPrompt: string): Set<string> {
  const headings = new Set<string>();
  const match = /<codemode>\n([\s\S]*?)\n<\/codemode>/.exec(systemPrompt);
  if (!match) return headings;
  for (const line of match[1]!.split("\n")) {
    if (line.startsWith("### `")) headings.add(line);
  }
  return headings;
}

export function captureCodemodeCatalog(
  agent: Pick<Agent<ToolRegistration>, "callable" | "extensions">,
  messages: readonly Message[],
): StoredCodemodeCatalog | undefined {
  const normalized = normalizeContext({ messages: [...messages] }).messages;
  if (!getCurrentTools(normalized).some(tool => tool.name === CODEMODE_TOOL_NAME)) return undefined;
  const callable = agent.callable.filter(tool => !tool.name.startsWith(CODEMODE_INTERNAL_PREFIX));
  const { declared, byTool } = resolveNamespaces(agent.extensions);
  if (callable.length === 0 && declared.length === 0) return undefined;

  const headings = inlineCodemodeHeadings(getCurrentSystemPrompt(normalized));
  const nsCounts = new Map<string, { total: number; inlined: number }>(
    declared.map(ns => [ns.name, { total: 0, inlined: 0 }]),
  );

  let inlinedCount = 0;
  let catalogTruncated = false;
  let runningBytes = 0;
  const encoder = new TextEncoder();
  const tools: CodemodeToolItem[] = [];

  for (const tool of callable) {
    const jsName = toCodemodeIdentifier(tool.name);
    const heading = jsName === tool.name ? `### \`${jsName}\`` : `### \`${jsName}\` (\`${tool.name}\`)`;
    const inlined = headings.has(heading);
    if (inlined) inlinedCount++;
    const ns = byTool.get(tool.name);
    if (ns) {
      const stat = nsCounts.get(ns.name);
      if (stat) {
        stat.total++;
        if (inlined) stat.inlined++;
      }
    }
    if (tools.length >= MAX_CATALOG_TOOLS || runningBytes >= SOFT_CATALOG_BYTES) {
      catalogTruncated = true;
      continue;
    }

    const signature = renderToolSignature({
      name: tool.name,
      inputSchema: tool.parameters as CodemodeJsonSchema,
      outputSchema: (tool.structuredOutputSchema ?? TEXT_OUTPUT_SCHEMA) as CodemodeJsonSchema,
    });
    const rawDeclaration = `declare const tools: { ${signature} };`;
    const rawDescription = tool.description ?? "";
    const rawInput = JSON.stringify(tool.parameters ?? {}, null, 2);
    const rawOutput = tool.structuredOutputSchema !== undefined ? JSON.stringify(tool.structuredOutputSchema, null, 2) : undefined;

    const descField = boundedField(rawDescription, 2_000);
    const declField = boundedField(rawDeclaration, 8_000);
    const inputField = boundedField(rawInput, 8_000);
    const outputField = rawOutput !== undefined ? boundedField(rawOutput, 4_000) : undefined;
    const itemTruncated = descField.truncated || declField.truncated || inputField.truncated || Boolean(outputField?.truncated);
    if (itemTruncated) catalogTruncated = true;

    const item: CodemodeToolItem = {
      name: safeText(tool.name).slice(0, 200),
      jsName: safeText(jsName).slice(0, 200),
      ...(ns ? { namespace: safeText(ns.name).slice(0, 120) } : {}),
      inlined,
      ...(tool.deferred ? { deferred: true } : {}),
      chars: rawDescription.length + rawDeclaration.length,
      truncated: itemTruncated,
      description: descField.text,
      declaration: declField.text,
      inputSchema: inputField.text,
      ...(outputField ? { outputSchema: outputField.text } : {}),
    };
    const itemBytes = encoder.encode(JSON.stringify(item)).byteLength;
    if (runningBytes + itemBytes > SOFT_CATALOG_BYTES && tools.length > 0) {
      catalogTruncated = true;
      continue;
    }
    runningBytes += itemBytes;
    tools.push(item);
  }

  const namespaces: CodemodeNamespaceItem[] = declared.map(ns => {
    const counts = nsCounts.get(ns.name) ?? { total: 0, inlined: 0 };
    const descField = boundedField(ns.description ?? "", 1_000);
    const instField = ns.instructions ? boundedField(ns.instructions, 2_000) : undefined;
    if (descField.truncated || instField?.truncated) catalogTruncated = true;
    return {
      name: safeText(ns.name).slice(0, 120),
      description: descField.text,
      ...(instField ? { instructions: instField.text } : {}),
      total: counts.total,
      inlined: counts.inlined,
    };
  });

  const total = callable.length;
  const hidden = total - inlinedCount;
  const digest = sha256Hex(JSON.stringify({ total, inlined: inlinedCount, hidden, truncated: catalogTruncated, namespaces, tools }));
  return {
    summary: { digest, total, inlined: inlinedCount, hidden },
    truncated: catalogTruncated,
    namespaces,
    tools,
  };
}

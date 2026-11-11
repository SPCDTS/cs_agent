import { Type, type TSchema } from "typebox";
import { copyJson } from "@earendil-works/chord";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";

export const MCP_RESULT_INSTRUCTIONS = "远端 MCP 工具及 mcp_resources_* 返回 { content, structuredContent?, isError? }。结构化字段从 result.structuredContent 读取；content 中的 text 块用 text(block.text)，image 块必须用 image(block) 展示，模型才能看到。不要用 text(result) 打印图片 Base64，也不要仅凭 frameId 判断已看到截图。";

const contentSchema = Type.Array(Type.Union([
  Type.Object({ type: Type.Literal("text"), text: Type.String() }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() }, { additionalProperties: false }),
]));

/** 远端 schema 的本地引用仍相对原根；嵌入返回对象后，只重定位 schema 节点中的引用。 */
function embeddedSchema(schema: TSchema): TSchema {
  const result = structuredClone(schema);
  function visit(node: unknown) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    if ("$ref" in node && typeof node.$ref === "string" && node.$ref.startsWith("#")) {
      node.$ref = "#/properties/structuredContent" + node.$ref.slice(1);
    }
    for (const key of ["properties", "patternProperties", "$defs", "definitions", "dependencies"]) {
      const map: unknown = Reflect.get(node, key);
      if (map && typeof map === "object" && !Array.isArray(map)) for (const child of Object.values(map)) visit(child);
    }
    for (const key of ["allOf", "anyOf", "oneOf", "items"]) {
      const child: unknown = Reflect.get(node, key);
      if (Array.isArray(child)) child.forEach(visit); else visit(child);
    }
    for (const key of ["additionalProperties", "propertyNames", "additionalItems", "contains", "not", "if", "then", "else"]) visit(Reflect.get(node, key));
  }
  visit(result);
  return result;
}

export function mcpCodemodeSchema(output?: TSchema) {
  return Type.Object({ content: contentSchema, structuredContent: Type.Optional(output ? embeddedSchema(output) : Type.Record(Type.String(), Type.Unknown())),
    isError: Type.Optional(Type.Boolean()) }, { additionalProperties: false });
}

/** Code Mode 只把 structuredOutput 交给脚本，因此内容块必须和远端结构化数据一起传递。 */
export function mcpCodemodeResult(result: ToolExecutionResult): ToolExecutionResult {
  if (result.isError && result.structuredOutput === undefined) return result;
  return { ...result, structuredOutput: { content: copyJson(result.output ?? []),
    ...(result.structuredOutput === undefined ? {} : { structuredContent: result.structuredOutput }),
    ...(result.isError ? { isError: true } : {}) } };
}

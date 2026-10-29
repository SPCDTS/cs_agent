import { copyJson, type JsonValue } from "@earendil-works/chord";
import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import type { McpLimits } from "./config";

const jsonType = Type.Union(["object", "array", "string", "number", "integer", "boolean", "null"].map(t => Type.Literal(t)));
const natural = Type.Integer({ minimum: 0 });
const listOfSchemas = Type.Array(Type.Unknown(), { minItems: 1 });
const mapOfSchemas = Type.Record(Type.String(), Type.Unknown());
const optional = Type.Optional;
const nodeSchema = Type.Object({
  $schema: optional(Type.String({ maxLength: 256 })), $ref: optional(Type.String()), $comment: optional(Type.String()),
  title: optional(Type.String()), description: optional(Type.String()), default: optional(Type.Unknown()), examples: optional(Type.Array(Type.Unknown())),
  readOnly: optional(Type.Boolean()), writeOnly: optional(Type.Boolean()),
  type: optional(Type.Union([jsonType, Type.Array(jsonType, { minItems: 1, uniqueItems: true })])),
  enum: optional(Type.Array(Type.Unknown(), { minItems: 1 })), const: optional(Type.Unknown()),
  definitions: optional(mapOfSchemas), $defs: optional(mapOfSchemas), properties: optional(mapOfSchemas), patternProperties: optional(mapOfSchemas),
  required: optional(Type.Array(Type.String(), { uniqueItems: true })), additionalProperties: optional(Type.Unknown()), propertyNames: optional(Type.Unknown()),
  minProperties: optional(natural), maxProperties: optional(natural), dependencies: optional(mapOfSchemas),
  items: optional(Type.Unknown()), additionalItems: optional(Type.Unknown()), contains: optional(Type.Unknown()),
  minItems: optional(natural), maxItems: optional(natural), uniqueItems: optional(Type.Boolean()),
  minLength: optional(natural), maxLength: optional(natural), pattern: optional(Type.String()),
  format: optional(Type.Union(["date-time", "date", "time", "email", "hostname", "ipv4", "ipv6", "uri", "uri-reference", "uri-template", "json-pointer", "relative-json-pointer", "regex"].map(t => Type.Literal(t)))),
  minimum: optional(Type.Number()), maximum: optional(Type.Number()), exclusiveMinimum: optional(Type.Number()), exclusiveMaximum: optional(Type.Number()),
  multipleOf: optional(Type.Number({ exclusiveMinimum: 0 })),
  allOf: optional(listOfSchemas), anyOf: optional(listOfSchemas), oneOf: optional(listOfSchemas),
  not: optional(Type.Unknown()), if: optional(Type.Unknown()), then: optional(Type.Unknown()), else: optional(Type.Unknown()),
}, { additionalProperties: false });

type SchemaRejectionReason = "unknown_keyword" | "ref_external" | "ref_unresolved" | "cycle" | "schema_limit" | "schema_invalid";
export class McpSchemaError extends Error {
  constructor(readonly reason: SchemaRejectionReason) { super("MCP schema 不受支持、无效或超过限额"); }
}
function reject(reason: SchemaRejectionReason = "schema_invalid"): never { throw new McpSchemaError(reason); }

class JsonBoundaryError extends Error {
  constructor(readonly reason: "schema_invalid" | "schema_limit" | "cycle") { super("MCP JSON 无效或超过限额"); }
}
function fail(reason: JsonBoundaryError["reason"] = "schema_invalid"): never { throw new JsonBoundaryError(reason); }

/** 先限制深度和占用，再复制严格 JSON；不执行 toJSON 或访问器。超限或非 JSON 时抛错。 */
export function boundedJson(input: unknown, maxBytes: number, maxDepth: number): JsonValue {
  let bytes = 0;
  const active = new Set<object>();
  function visit(value: unknown, depth: number): void {
    if (depth > maxDepth) fail("schema_limit");
    if (typeof value === "string") bytes += Buffer.byteLength(value, "utf8") + 2;
    else if (value === null || typeof value === "boolean" || typeof value === "number") bytes += 8;
    else if (typeof value === "object") {
      if (active.has(value)) fail("cycle");
      active.add(value);
      bytes += 2;
      for (const key of Reflect.ownKeys(value)) {
        if (Array.isArray(value) && key === "length") continue;
        if (typeof key !== "string") fail();
        bytes += Buffer.byteLength(key, "utf8") + 4;
        if (bytes > maxBytes * 2) fail("schema_limit");
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) fail();
        visit(descriptor.value, depth + 1);
      }
      active.delete(value);
    } else fail();
    if (bytes > maxBytes * 2) fail("schema_limit");
  }
  visit(input, 0);
  const result = copyJson(input);
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > maxBytes) fail("schema_limit");
  return result;
}

function isObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 首版采用严格 draft-07 子集；未知关键字不会被编译器静默忽略。 */
export function compileMcpSchema(input: unknown, limits: McpLimits): { schema: TSchema; check(value: unknown): boolean } {
  try {
    // 数据树层数包含 properties/数组容器；schema 深度另外计算引用与子 schema。
    const schema = boundedJson(input, limits.schemaBytes, limits.schemaDepth * 3 + 3);
    if (!isObject(schema) || schema.type !== "object") reject();
    const active = new Set<object>();
    let visits = 0;
    function resolve(ref: string): JsonValue {
      if (!ref.startsWith("#")) reject("ref_external");
      let pointer: string;
      try { pointer = decodeURIComponent(ref.slice(1)); } catch { return reject("ref_unresolved"); }
      if (pointer !== "" && !pointer.startsWith("/")) reject("ref_unresolved");
      let target: JsonValue = schema;
      if (pointer === "") return target;
      for (const token of pointer.slice(1).split("/")) {
        if (/~(?:[^01]|$)/u.test(token)) reject("ref_unresolved");
        const key = token.replace(/~1/gu, "/").replace(/~0/gu, "~");
        if (Array.isArray(target)) {
          if (!/^(?:0|[1-9][0-9]*)$/u.test(key) || !Object.hasOwn(target, key)) reject("ref_unresolved");
          target = target[Number(key)];
        } else {
          if (!isObject(target) || !Object.hasOwn(target, key)) reject("ref_unresolved");
          target = target[key];
        }
      }
      return target;
    }
    function visit(value: unknown, depth: number): void {
      if (depth > limits.schemaDepth || ++visits > limits.schemaBytes) reject("schema_limit");
      if (typeof value === "boolean") return;
      if (value === null || typeof value !== "object" || Array.isArray(value)) reject();
      if (active.has(value)) reject("cycle");
      if (!Check(nodeSchema, value)) reject(Object.keys(value).some(key => !Object.hasOwn(nodeSchema.properties, key)) ? "unknown_keyword" : "schema_invalid");
      const node = value;
      // 方言声明只作有界注解；仅删除 schema 节点上的键，保留业务数据中的同名字段。
      Reflect.deleteProperty(value, "$schema");
      active.add(value);
      if (node.$ref !== undefined) {
        if (Object.keys(node).some(key => !["$ref", "$schema", "$comment", "title", "description"].includes(key))) reject();
        visit(resolve(node.$ref), depth + 1);
      }
      if (node.pattern !== undefined) new RegExp(node.pattern, "u");
      if (node.patternProperties) for (const pattern of Object.keys(node.patternProperties)) new RegExp(pattern, "u");
      if (node.enum && new Set(node.enum.map(item => JSON.stringify(item))).size !== node.enum.length) reject();
      for (const map of [node.definitions, node.$defs, node.properties, node.patternProperties]) {
        if (map) for (const child of Object.values(map)) visit(child, depth + 1);
      }
      for (const children of [node.allOf, node.anyOf, node.oneOf]) {
        if (children) for (const child of children) visit(child, depth + 1);
      }
      for (const child of [node.additionalProperties, node.propertyNames, node.additionalItems, node.contains, node.not, node.if, node.then, node.else]) {
        if (child !== undefined) visit(child, depth + 1);
      }
      if (Array.isArray(node.items)) {
        if (node.items.length === 0) reject();
        for (const child of node.items) visit(child, depth + 1);
      } else if (node.items !== undefined) visit(node.items, depth + 1);
      if (node.dependencies) for (const child of Object.values(node.dependencies)) {
        if (Array.isArray(child)) {
          if (!child.every(item => typeof item === "string") || new Set(child).size !== child.length) reject();
        } else visit(child, depth + 1);
      }
      active.delete(value);
    }
    visit(schema, 1);
    // Workers 禁止运行期 new Function；解释式 Check 保留相同 JSON Schema 语义。
    return {
      schema,
      check(value: unknown): boolean {
        try {
          const owned = boundedJson(value, Math.max(limits.argumentBytes, limits.structuredBytes), limits.schemaDepth * 3 + 3);
          return Check(schema, owned);
        } catch { return false; }
      },
    };
  } catch (error) {
    if (error instanceof McpSchemaError) throw error;
    return reject(error instanceof JsonBoundaryError ? error.reason : "schema_invalid");
  }
}

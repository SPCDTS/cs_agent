import { copyJson, type JsonValue } from "@earendil-works/chord";
import type { TSchema } from "@earendil-works/pi-ai";
import { Compile } from "typebox/compile";
import { z } from "zod";
import type { McpLimits } from "./config.js";

const jsonType = z.enum(["object", "array", "string", "number", "integer", "boolean", "null"]);
const natural = z.number().int().nonnegative();
const listOfSchemas = z.array(z.unknown()).min(1);
const mapOfSchemas = z.record(z.string(), z.unknown());
const formats = z.enum(["date-time", "date", "time", "email", "hostname", "ipv4", "ipv6", "uri", "uri-reference", "uri-template", "json-pointer", "relative-json-pointer", "regex"]);
const nodeSchema = z.strictObject({
  $schema: z.string().max(256).optional(),
  $ref: z.string().optional(), $comment: z.string().optional(),
  title: z.string().optional(), description: z.string().optional(),
  default: z.unknown().optional(), examples: z.array(z.unknown()).optional(),
  readOnly: z.boolean().optional(), writeOnly: z.boolean().optional(),
  type: z.union([jsonType, z.array(jsonType).min(1).refine(value => new Set(value).size === value.length)]).optional(),
  enum: z.array(z.unknown()).min(1).optional(), const: z.unknown().optional(),
  definitions: mapOfSchemas.optional(), $defs: mapOfSchemas.optional(),
  properties: mapOfSchemas.optional(), patternProperties: mapOfSchemas.optional(),
  required: z.array(z.string()).refine(value => new Set(value).size === value.length).optional(),
  additionalProperties: z.unknown().optional(), propertyNames: z.unknown().optional(),
  minProperties: natural.optional(), maxProperties: natural.optional(),
  dependencies: z.record(z.string(), z.unknown()).optional(),
  items: z.unknown().optional(), additionalItems: z.unknown().optional(), contains: z.unknown().optional(),
  minItems: natural.optional(), maxItems: natural.optional(), uniqueItems: z.boolean().optional(),
  minLength: natural.optional(), maxLength: natural.optional(), pattern: z.string().optional(), format: formats.optional(),
  minimum: z.number().optional(), maximum: z.number().optional(),
  exclusiveMinimum: z.number().optional(), exclusiveMaximum: z.number().optional(), multipleOf: z.number().positive().optional(),
  allOf: listOfSchemas.optional(), anyOf: listOfSchemas.optional(), oneOf: listOfSchemas.optional(),
  not: z.unknown().optional(), if: z.unknown().optional(), then: z.unknown().optional(), else: z.unknown().optional(),
});

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
      const parsed = nodeSchema.safeParse(value);
      if (!parsed.success) reject(parsed.error.issues.some(issue => issue.code === "unrecognized_keys") ? "unknown_keyword" : "schema_invalid");
      const node = parsed.data;
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
    const validator = Compile(schema);
    return {
      schema,
      check(value: unknown): boolean {
        try {
          const owned = boundedJson(value, Math.max(limits.argumentBytes, limits.structuredBytes), limits.schemaDepth * 3 + 3);
          return validator.Check(owned);
        } catch { return false; }
      },
    };
  } catch (error) {
    if (error instanceof McpSchemaError) throw error;
    return reject(error instanceof JsonBoundaryError ? error.reason : "schema_invalid");
  }
}

// JSON Schema inference for captured messages.
//
// A Foxglove panel receives decoded message objects and a schema *name*, but not
// the schema *definition*. To write a proper MCAP whose topics carry schemas, we
// synthesize a JSON Schema from the observed message shapes, merging across
// messages so optional fields and array element types are captured.

export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  contentEncoding?: string;
};

const EMPTY: JsonSchema = {};

function isEmpty(schema: JsonSchema): boolean {
  return (
    schema.type == undefined &&
    schema.properties == undefined &&
    schema.items == undefined &&
    schema.contentEncoding == undefined
  );
}

/** Infer a JSON Schema fragment describing a single value. */
export function inferJsonSchema(value: unknown): JsonSchema {
  if (value == undefined) {
    return { ...EMPTY };
  }
  if (typeof value === "boolean") {
    return { type: "boolean" };
  }
  if (typeof value === "bigint") {
    // Serialized to a string (JSON has no int64), so type it as such.
    return { type: "string" };
  }
  if (typeof value === "number") {
    return { type: Number.isInteger(value) ? "integer" : "number" };
  }
  if (typeof value === "string") {
    return { type: "string" };
  }
  if (value instanceof Uint8Array) {
    // Unsigned byte arrays -> base64 string (see the worker's replacer); the app
    // decodes contentEncoding:base64 back to a Uint8Array. Int8Array is NOT
    // base64'd — normalizeInt8Array (OccupancyGrid) rejects Uint8Array.
    return { type: "string", contentEncoding: "base64" };
  }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    // Other typed arrays (Int8Array, Float32Array, etc.) encode as number arrays.
    return { type: "array", items: { type: "number" } };
  }
  if (Array.isArray(value)) {
    let items: JsonSchema = { ...EMPTY };
    for (const element of value) {
      items = mergeJsonSchema(items, inferJsonSchema(element));
    }
    return { type: "array", items };
  }
  if (typeof value === "object") {
    const properties: Record<string, JsonSchema> = {};
    for (const [key, element] of Object.entries(value as Record<string, unknown>)) {
      properties[key] = inferJsonSchema(element);
    }
    return { type: "object", properties };
  }
  return { ...EMPTY };
}

/** Merge two inferred schemas, widening to cover both. */
export function mergeJsonSchema(a: JsonSchema, b: JsonSchema): JsonSchema {
  if (isEmpty(a)) {
    return b;
  }
  if (isEmpty(b)) {
    return a;
  }
  if (a.type === "object" && b.type === "object") {
    const properties: Record<string, JsonSchema> = { ...a.properties };
    for (const [key, schema] of Object.entries(b.properties ?? {})) {
      const existing = properties[key];
      properties[key] = existing ? mergeJsonSchema(existing, schema) : schema;
    }
    return { type: "object", properties };
  }
  if (a.type === "array" && b.type === "array") {
    return {
      type: "array",
      items: mergeJsonSchema(a.items ?? { ...EMPTY }, b.items ?? { ...EMPTY }),
    };
  }
  if (a.type === b.type) {
    return a;
  }
  const numeric = new Set(["integer", "number"]);
  if (
    typeof a.type === "string" &&
    typeof b.type === "string" &&
    numeric.has(a.type) &&
    numeric.has(b.type)
  ) {
    return { type: "number" };
  }
  // Conflicting scalar types: keep the first seen. Rare in practice for a topic.
  return a;
}

/** Produce the top-level schema for a message object, always an object at the root. */
export function rootSchema(value: unknown): JsonSchema {
  const inferred = inferJsonSchema(value);
  if (inferred.type === "object") {
    return inferred;
  }
  // Non-object top-level messages are unusual; wrap so the schema is still valid.
  return { type: "object", properties: {} };
}

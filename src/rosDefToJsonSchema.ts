import { MessageDefinition, MessageDefinitionField } from "@foxglove/message-definition";

import { JsonSchema } from "./inferSchema";

// Convert a parsed ROS message definition into a JSON Schema that mirrors how
// Foxglove's own schemas describe messages:
//   - uint8[] / int8[] (byte arrays) -> { type: "string", contentEncoding: "base64" }
//   - other numeric arrays          -> { type: "array", items: <scalar> }
//   - nested complex types          -> recursively expanded objects
//
// This matches what the app's json codec expects (base64 -> Uint8Array on read),
// so byte fields stay compact and image panels get real Uint8Arrays.

type DefMap = ReadonlyMap<string, MessageDefinition>;

const SCALAR_TYPE: Record<string, JsonSchema> = {
  bool: { type: "boolean" },
  byte: { type: "integer" },
  char: { type: "integer" },
  int8: { type: "integer" },
  uint8: { type: "integer" },
  int16: { type: "integer" },
  uint16: { type: "integer" },
  int32: { type: "integer" },
  uint32: { type: "integer" },
  // JSON has no int64; Foxglove types these as integer. Large magnitudes may lose
  // precision — acceptable for the spike, noted in the idea README.
  int64: { type: "integer" },
  uint64: { type: "integer" },
  float32: { type: "number" },
  float64: { type: "number" },
  string: { type: "string" },
  wstring: { type: "string" },
};

// ROS time/duration decode to { sec, nanosec }.
const TIME_SCHEMA: JsonSchema = {
  type: "object",
  properties: { sec: { type: "integer" }, nanosec: { type: "integer" } },
};

// Only UNSIGNED byte arrays go to base64. The app decodes contentEncoding:base64
// to a Uint8Array; `normalizeByteArray` (images) accepts that, but
// `normalizeInt8Array` (OccupancyGrid.data = int8[]) rejects a Uint8Array and
// returns empty. So int8[] must stay a plain JSON number array.
const BASE64_ARRAY_TYPES = new Set(["uint8"]);

function fieldSchema(field: MessageDefinitionField, defs: DefMap, seen: Set<string>): JsonSchema {
  // Unsigned byte arrays -> a single base64 string.
  if (field.isArray === true && BASE64_ARRAY_TYPES.has(field.type)) {
    return { type: "string", contentEncoding: "base64" };
  }

  const element = elementSchema(field, defs, seen);
  if (field.isArray === true) {
    return { type: "array", items: element };
  }
  return element;
}

function elementSchema(field: MessageDefinitionField, defs: DefMap, seen: Set<string>): JsonSchema {
  if (field.isComplex === true) {
    if (field.type === "builtin_interfaces/Time" || field.type === "builtin_interfaces/Duration") {
      return TIME_SCHEMA;
    }
    const nested = defs.get(field.type);
    if (nested && !seen.has(field.type)) {
      return defToJsonSchema(nested, defs, new Set(seen).add(field.type));
    }
    return { type: "object" };
  }
  if (field.type === "time" || field.type === "duration") {
    return TIME_SCHEMA;
  }
  return SCALAR_TYPE[field.type] ?? {};
}

export function defToJsonSchema(
  def: MessageDefinition,
  defs: DefMap,
  seen = new Set<string>(),
): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const field of def.definitions) {
    if (field.isConstant === true) {
      continue;
    }
    properties[field.name] = fieldSchema(field, defs, seen);
  }
  return { type: "object", properties };
}

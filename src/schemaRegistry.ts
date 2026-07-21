import { MessageDefinition } from "@foxglove/message-definition";
import { ros2humble } from "@foxglove/rosmsg-msgs-common";
// Foxglove's own JSON Schemas (byte fields already typed as base64). This is the
// SDK's published schema set.
import * as foxgloveJsonSchemas from "@foxglove/schemas/jsonschema";

import { JsonSchema } from "./inferSchema";
import { defToJsonSchema } from "./rosDefToJsonSchema";

const ros2Defs: ReadonlyMap<string, MessageDefinition> = new Map(
  Object.entries(ros2humble as Record<string, MessageDefinition>),
);

const foxgloveByName = foxgloveJsonSchemas as unknown as Record<string, JsonSchema | undefined>;

const cache = new Map<string, JsonSchema | undefined>();

/**
 * Resolve a real JSON Schema for a wire schema name, or `undefined` if unknown
 * (caller should fall back to shape inference).
 *
 * - `foxglove.CompressedImage` -> the SDK's published JSON Schema.
 * - `sensor_msgs/msg/LaserScan` (or `sensor_msgs/LaserScan`) -> generated from
 *   the bundled ROS2 (Humble) definitions.
 */
export function resolveSchema(schemaName: string): JsonSchema | undefined {
  if (cache.has(schemaName)) {
    return cache.get(schemaName);
  }
  const resolved = compute(schemaName);
  cache.set(schemaName, resolved);
  return resolved;
}

function compute(schemaName: string): JsonSchema | undefined {
  if (schemaName.startsWith("foxglove.")) {
    const shortName = schemaName.slice("foxglove.".length);
    return foxgloveByName[shortName];
  }

  // ROS2 wire names are "pkg/msg/Type"; the common-defs map keys are "pkg/Type".
  const rosKey = schemaName.replace("/msg/", "/");
  const def = ros2Defs.get(rosKey);
  if (def) {
    return defToJsonSchema(def, ros2Defs);
  }

  return undefined;
}

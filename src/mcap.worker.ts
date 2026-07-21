// Web Worker: owns the capture buffer and all encoding.
//
// Bundled to a string by scripts/bundle-worker.mjs (esbuild, with @mcap/core) and
// instantiated from a Blob URL by the panel, so it travels inside the extension
// bundle. Messages arrive decoded from the panel; the worker JSON-encodes them and,
// on save, frames them into a fully indexed MCAP with per-topic synthesized schemas.

import { buildMcap, DvrRecord, DvrSchema } from "./buildMcap";
import { JsonSchema, mergeJsonSchema, rootSchema } from "./inferSchema";
import { resolveSchema } from "./schemaRegistry";

type Time = { sec: number; nsec: number };

type InboundMessage =
  | {
      type: "msg";
      topic: string;
      schemaName?: string;
      receiveTime?: Time;
      publishTime?: Time;
      message: unknown;
    }
  | { type: "save" }
  | { type: "reset" };

// The DOM lib types `self.postMessage` like Window's; cast to the worker shape.
const ctx = self as unknown as {
  onmessage: ((event: { data: InboundMessage }) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};

const encoder = new TextEncoder();

const records: DvrRecord[] = [];
// Per topic: a fixed schema resolved from the registry (real schema), or an
// inferred one we keep merging as messages arrive.
type TopicSchema = { name: string; schema: JsonSchema; fromRegistry: boolean };
const schemaByTopic = new Map<string, TopicSchema>();
let messageCount = 0;

function toNanos(time?: Time): bigint {
  if (time == undefined) {
    return 0n;
  }
  return BigInt(time.sec) * 1_000_000_000n + BigInt(time.nsec);
}

function toBase64(view: ArrayBufferView): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + chunkSize) as unknown as number[],
    );
  }
  return btoa(binary);
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return Number(value);
  }
  // Unsigned byte arrays -> base64 string (matches contentEncoding:base64 in the
  // schema). Int8Array is intentionally NOT base64'd: the app's normalizeInt8Array
  // (OccupancyGrid.data) rejects a Uint8Array, so it must stay a number array.
  if (value instanceof Uint8Array) {
    return toBase64(value);
  }
  // Other typed arrays (Int8Array, Float32Array, etc.) -> plain number arrays.
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return Array.from(value as unknown as ArrayLike<number>);
  }
  return value;
}

function encodeMessage(message: unknown): Uint8Array {
  let json: string;
  try {
    json = JSON.stringify(message, jsonReplacer) ?? "null";
  } catch (err) {
    json = JSON.stringify({ __dvr_encode_error: String(err) });
  }
  return encoder.encode(json);
}

function handleMessage(msg: Extract<InboundMessage, { type: "msg" }>): void {
  const name =
    msg.schemaName != undefined && msg.schemaName.length > 0 ? msg.schemaName : msg.topic;
  const existing = schemaByTopic.get(msg.topic);
  if (existing == undefined) {
    // First message on this topic: prefer a real schema from the registry.
    const registrySchema = name.length > 0 ? resolveSchema(name) : undefined;
    schemaByTopic.set(
      msg.topic,
      registrySchema
        ? { name, schema: registrySchema, fromRegistry: true }
        : { name, schema: rootSchema(msg.message), fromRegistry: false },
    );
  } else if (!existing.fromRegistry) {
    // Unknown schema: keep refining the inferred shape as more messages arrive.
    existing.schema = mergeJsonSchema(existing.schema, rootSchema(msg.message));
  }

  const logTime = toNanos(msg.receiveTime);
  records.push({
    topic: msg.topic,
    logTime,
    publishTime: msg.publishTime != undefined ? toNanos(msg.publishTime) : logTime,
    data: encodeMessage(msg.message),
  });

  messageCount++;
  if (messageCount % 200 === 0) {
    ctx.postMessage({ type: "stat", messageCount, channels: schemaByTopic.size });
  }
}

function handleSave(): void {
  const schemas = new Map<string, DvrSchema>();
  for (const [topic, entry] of schemaByTopic) {
    schemas.set(topic, {
      name: entry.name,
      encoding: "jsonschema",
      data: encoder.encode(JSON.stringify(entry.schema)),
    });
  }

  buildMcap(records, schemas)
    .then((bytes) => {
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      ctx.postMessage({ type: "saved", buffer, messageCount, channels: schemaByTopic.size }, [
        buffer,
      ]);
    })
    .catch((err: unknown) => {
      ctx.postMessage({ type: "error", message: String(err) });
    });
}

function handleReset(): void {
  records.length = 0;
  schemaByTopic.clear();
  messageCount = 0;
  ctx.postMessage({ type: "stat", messageCount: 0, channels: 0 });
}

ctx.onmessage = (event) => {
  const data = event.data;
  switch (data.type) {
    case "msg":
      handleMessage(data);
      break;
    case "save":
      handleSave();
      break;
    case "reset":
      handleReset();
      break;
  }
};

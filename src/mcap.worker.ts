// Web Worker: owns the capture buffer and all encoding.
//
// Bundled to a string by scripts/bundle-worker.mjs (esbuild, with @mcap/core) and
// instantiated from a Blob URL by the panel, so it travels inside the extension
// bundle. Messages arrive decoded from the panel; the worker JSON-encodes them and,
// on save, frames them into a fully indexed MCAP with per-topic synthesized schemas.
//
// v1 adds a bounded ring buffer (time / byte budget) and auto-save rotation: when
// auto-save is on and the budget is exceeded, the whole window is snapshotted,
// synchronously cleared, and asynchronously framed to an MCAP (posted as "saved")
// instead of dropping data — yielding contiguous rotated files. The panel owns all
// file writing; the worker only posts buffers.

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
  | {
      type: "config";
      budgetMode: "time" | "bytes";
      budgetNanos?: bigint;
      budgetBytes?: number;
      autoSave: boolean;
      enabledTopics: string[];
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
// Running total of buffered re-encoded JSON payload bytes (sum of data.byteLength).
let byteTotal = 0;
// Per topic: a fixed schema resolved from the registry (real schema), or an
// inferred one we keep merging as messages arrive.
type TopicSchema = { name: string; schema: JsonSchema; fromRegistry: boolean };
const schemaByTopic = new Map<string, TopicSchema>();
let messageCount = 0;
let rotations = 0;

// Latest config. Unbounded / no-autosave until the first "config" message arrives.
let budgetMode: "time" | "bytes" = "time";
let budgetNanos: bigint | undefined = undefined;
let budgetBytes: number | undefined = undefined;
let autoSave = false;
let enabledSet: Set<string> | undefined = undefined;

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
  try {
    if (message === undefined) {
      return encoder.encode("null");
    }
    const json = JSON.stringify(message, jsonReplacer);
    return encoder.encode(json);
  } catch (err) {
    return encoder.encode(JSON.stringify({ __dvr_encode_error: String(err) }));
  }
}

/** Snapshot the current per-topic schemas into the framing shape (name/encoding/data). */
function snapshotSchemaMap(): Map<string, DvrSchema> {
  const schemas = new Map<string, DvrSchema>();
  for (const [topic, entry] of schemaByTopic) {
    schemas.set(topic, {
      name: entry.name,
      encoding: "jsonschema",
      data: encoder.encode(JSON.stringify(entry.schema)),
    });
  }
  return schemas;
}

function postStat(): void {
  const oldest = records[0];
  const newest = records[records.length - 1];
  ctx.postMessage({
    type: "stat",
    messageCount,
    channels: schemaByTopic.size,
    bufferedMsgs: records.length,
    byteTotal,
    oldestNanos: (oldest?.logTime ?? 0n).toString(),
    newestNanos: (newest?.logTime ?? 0n).toString(),
    rotations,
  });
}

/** Async-frame a snapshot to an MCAP and post it as a rotation "saved" event. */
function flushRotation(snapshot: DvrRecord[], snapshotSchemas: Map<string, DvrSchema>): void {
  buildMcap(snapshot, snapshotSchemas)
    .then((bytes) => {
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      ctx.postMessage(
        { type: "saved", buffer, messageCount, channels: schemaByTopic.size, rotation: true },
        [buffer],
      );
    })
    .catch((err: unknown) => {
      ctx.postMessage({ type: "error", message: String(err) });
    });
}

/**
 * Enforce the configured budget after a push. When auto-save is off this is a
 * true ring (evict oldest). When auto-save is on, a budget-exceed snapshots the
 * whole window, clears it synchronously (the re-entrancy guard — the next message
 * starts a fresh window, so a slow build can never double-flush), and kicks off an
 * async build. Schemas persist across windows so every rotated file is self-contained.
 */
function enforceBudget(): void {
  if (budgetMode === "time" && budgetNanos != undefined) {
    while (records.length > 1) {
      const oldest = records[0];
      const newest = records[records.length - 1];
      if (oldest == undefined || newest == undefined) {
        break;
      }
      if (newest.logTime - oldest.logTime <= budgetNanos) {
        break;
      }
      if (rotateOrEvict()) {
        break; // rotation cleared the buffer; nothing left to trim
      }
    }
  } else if (budgetMode === "bytes" && budgetBytes != undefined) {
    while (records.length > 0 && byteTotal > budgetBytes) {
      if (rotateOrEvict()) {
        break;
      }
    }
  }
}

/**
 * Evict the oldest record (ring) or rotate the whole window (auto-save).
 * Returns true when a rotation cleared the buffer (caller should stop looping).
 */
function rotateOrEvict(): boolean {
  if (autoSave) {
    const snapshot = records.slice();
    const snapshotSchemas = snapshotSchemaMap();
    records.length = 0;
    byteTotal = 0;
    rotations++;
    flushRotation(snapshot, snapshotSchemas);
    postStat();
    return true;
  }
  const gone = records.shift();
  if (gone != undefined) {
    byteTotal -= gone.data.byteLength;
  }
  return false;
}

function handleMessage(msg: Extract<InboundMessage, { type: "msg" }>): void {
  // Defensively drop messages for a topic that was just disabled but is still in
  // flight (the panel already only subscribes to enabled topics).
  if (enabledSet != undefined && enabledSet.size > 0 && !enabledSet.has(msg.topic)) {
    return;
  }

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
  const data = encodeMessage(msg.message);
  records.push({
    topic: msg.topic,
    logTime,
    publishTime: msg.publishTime != undefined ? toNanos(msg.publishTime) : logTime,
    data,
  });
  byteTotal += data.byteLength;

  messageCount++;

  enforceBudget();

  if (messageCount % 200 === 0) {
    postStat();
  }
}

function handleConfig(cfg: Extract<InboundMessage, { type: "config" }>): void {
  budgetMode = cfg.budgetMode;
  budgetNanos = cfg.budgetNanos;
  budgetBytes = cfg.budgetBytes;
  autoSave = cfg.autoSave;
  enabledSet = new Set(cfg.enabledTopics);
  // A newly-tightened budget may already be exceeded by the current buffer.
  enforceBudget();
  postStat();
}

function handleSave(): void {
  // Manual save is non-destructive: frame the current window without clearing.
  const schemas = snapshotSchemaMap();
  buildMcap(records, schemas)
    .then((bytes) => {
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      ctx.postMessage(
        { type: "saved", buffer, messageCount, channels: schemaByTopic.size, rotation: false },
        [buffer],
      );
    })
    .catch((err: unknown) => {
      ctx.postMessage({ type: "error", message: String(err) });
    });
}

function handleReset(): void {
  records.length = 0;
  byteTotal = 0;
  schemaByTopic.clear();
  messageCount = 0;
  rotations = 0;
  postStat();
}

ctx.onmessage = (event) => {
  const data = event.data;
  switch (data.type) {
    case "msg":
      handleMessage(data);
      break;
    case "config":
      handleConfig(data);
      break;
    case "save":
      handleSave();
      break;
    case "reset":
      handleReset();
      break;
  }
};

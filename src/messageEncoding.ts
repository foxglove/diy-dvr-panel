// Turning one live message into the JSON bytes that go into an MCAP message record.
//
// Split out of `captureEngine.ts` because it is pure and holds no engine state: the rules
// below decide how JavaScript values the app hands a panel are represented in the file, so
// they are worth reading — and testing — on their own.

const encoder = new TextEncoder();

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

export function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    // JSON has no 64-bit integer. Within the double-safe range a number is what consumers
    // expect from an integer field, but past it a number would be a *different* value — so
    // emit the exact decimal string instead of silently rounding. (inferSchema already types
    // bigint fields as strings, so a string is the more consistent of the two.)
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  // Unsigned byte arrays -> base64 string (matches contentEncoding:base64 in the schema).
  // Int8Array is intentionally NOT base64'd: the app's normalizeInt8Array
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

/**
 * The message body as UTF-8 JSON. Never throws: a value JSON cannot represent is recorded as
 * an error envelope, so one bad message does not cost the capture.
 */
export function encodeMessage(message: unknown): Uint8Array {
  try {
    if (message == undefined) {
      return encoder.encode("null");
    }
    return encoder.encode(JSON.stringify(message, jsonReplacer));
  } catch (err) {
    return encoder.encode(JSON.stringify({ __dvr_encode_error: String(err) }));
  }
}

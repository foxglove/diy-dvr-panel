import { encodeMessage, jsonReplacer } from "./messageEncoding";

const decoder = new TextDecoder();

describe("jsonReplacer", () => {
  it("emits a bigint inside the double-safe range as a number", () => {
    expect(jsonReplacer("v", 42n)).toBe(42);
    expect(jsonReplacer("v", BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("emits a bigint past the double-safe range as an exact decimal string", () => {
    // A number here would be a *different* value, so the exact digits are kept.
    const tooBig = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
    expect(jsonReplacer("v", tooBig)).toBe("9007199254740993");
    expect(jsonReplacer("v", BigInt(Number.MIN_SAFE_INTEGER) - 2n)).toBe("-9007199254740993");
  });

  it("base64-encodes a Uint8Array", () => {
    expect(jsonReplacer("data", new Uint8Array([104, 105]))).toBe("aGk=");
  });

  it("leaves an Int8Array as a plain number array", () => {
    // normalizeInt8Array (OccupancyGrid.data) rejects a Uint8Array, so this must not be base64.
    expect(jsonReplacer("data", new Int8Array([-1, 0, 1]))).toEqual([-1, 0, 1]);
  });

  it("turns another typed array into a number array", () => {
    expect(jsonReplacer("data", new Float32Array([1.5, 2.5]))).toEqual([1.5, 2.5]);
  });

  it("passes anything else through untouched", () => {
    expect(jsonReplacer("v", "text")).toBe("text");
    expect(jsonReplacer("v", undefined)).toBeUndefined();
  });
});

describe("encodeMessage", () => {
  it("encodes a missing message as null", () => {
    expect(decoder.decode(encodeMessage(undefined))).toBe("null");
    expect(decoder.decode(encodeMessage(undefined))).toBe(decoder.decode(encodeMessage(null)));
  });

  it("round-trips a normal message through the replacer's rules", () => {
    const bytes = encodeMessage({
      count: 7n,
      label: "hi",
      data: new Uint8Array([104, 105]),
      grid: new Int8Array([-1, 2]),
    });
    expect(JSON.parse(decoder.decode(bytes))).toEqual({
      count: 7,
      label: "hi",
      data: "aGk=",
      grid: [-1, 2],
    });
  });

  it("records an unencodable message as an error envelope instead of throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const json = decoder.decode(encodeMessage(circular));
    expect(() => {
      JSON.parse(json);
    }).not.toThrow();
    expect(json).toContain("dvr_encode_error");
    expect(json).toContain("circular");
  });
});

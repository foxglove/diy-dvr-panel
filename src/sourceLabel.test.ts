import { detectSourceLabel, effectiveSourceLabel } from "./sourceLabel";

const noLocation = { search: "", hash: "" };

describe("detectSourceLabel", () => {
  it("reads the data-source URL out of the query string", () => {
    const location = {
      search: "?ds=foxglove-websocket&ds.url=ws%3A%2F%2Flocalhost%3A9000",
      hash: "",
    };
    expect(detectSourceLabel(location)).toBe("ws://localhost:9000");
  });

  it("reads it out of the hash too, routed or not", () => {
    expect(
      detectSourceLabel({
        search: "",
        hash: "#/view?ds=foxglove-websocket&ds.url=ws%3A%2F%2Frobot%3A8765",
      }),
    ).toBe("ws://robot:8765");
    expect(detectSourceLabel({ search: "", hash: "#ds.url=ws%3A%2F%2Frobot%3A8765" })).toBe(
      "ws://robot:8765",
    );
  });

  it("prefers the query string when both carry one", () => {
    expect(
      detectSourceLabel({ search: "?ds.url=ws%3A%2F%2Ffirst", hash: "#ds.url=ws%3A%2F%2Fsecond" }),
    ).toBe("ws://first");
  });

  it("returns nothing when there is no such source", () => {
    // A desktop file, a recording, or a data-platform source has no ds.url at all.
    expect(detectSourceLabel(noLocation)).toBe("");
    expect(detectSourceLabel({ search: "?ds=file&layoutId=abc", hash: "" })).toBe("");
    expect(detectSourceLabel({ search: "?ds.url=", hash: "" })).toBe("");
    expect(detectSourceLabel({ search: "?ds.url=%20%20", hash: "" })).toBe("");
  });

  it("never throws on a malformed location", () => {
    // A label is a nicety; nothing here is worth failing a capture over.
    for (const part of ["?%", "#%%%", "?ds.url=%E0%A4%A", "????", "#"]) {
      expect(() => detectSourceLabel({ search: part, hash: part })).not.toThrow();
    }
  });

  it("does not decode twice", () => {
    // A literal percent in the URL survives: decoding the already-decoded value would eat it.
    expect(detectSourceLabel({ search: "?ds.url=ws%3A%2F%2Fhost%2Fa%2520b", hash: "" })).toBe(
      "ws://host/a%20b",
    );
  });
});

describe("effectiveSourceLabel", () => {
  it("prefers what the user typed", () => {
    expect(effectiveSourceLabel("Bench robot", "ws://localhost:9000")).toBe("Bench robot");
  });

  it("falls back to what was detected", () => {
    expect(effectiveSourceLabel("", "ws://localhost:9000")).toBe("ws://localhost:9000");
    expect(effectiveSourceLabel("   ", "ws://localhost:9000")).toBe("ws://localhost:9000");
  });

  it("is empty when there is neither", () => {
    expect(effectiveSourceLabel("", "")).toBe("");
    expect(effectiveSourceLabel("  ", "")).toBe("");
  });

  it("trims what the user typed", () => {
    expect(effectiveSourceLabel("  Bench robot  ", "")).toBe("Bench robot");
  });
});

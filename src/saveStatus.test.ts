import { SaveResult, saveStatusSeverity, saveStatusText, statusFromResult } from "./saveStatus";

describe("saveStatusSeverity", () => {
  it("reports a folder write as clean", () => {
    const result: SaveResult = { mode: "folder", name: "a.mcap", folder: "captures" };
    expect(saveStatusSeverity(result)).toBe("ok");
  });

  it("reports a paused save as an error", () => {
    // Nothing was written, and an auto-save rotation has already dropped its window from
    // the live ring. This is the case that must not be quiet.
    expect(saveStatusSeverity({ mode: "paused" })).toBe("error");
  });

  it("reports a plain browser download as clean", () => {
    expect(saveStatusSeverity({ mode: "download", name: "a.mcap" })).toBe("ok");
  });

  it("warns when the file went somewhere other than the chosen folder", () => {
    expect(saveStatusSeverity({ mode: "download", name: "a.mcap", reason: "denied" })).toBe("warn");
    expect(
      saveStatusSeverity({ mode: "download", name: "a.mcap", reason: "error", error: "boom" }),
    ).toBe("warn");
  });
});

describe("saveStatusText", () => {
  it("names the file and folder on success", () => {
    expect(saveStatusText({ mode: "folder", name: "a.mcap", folder: "captures" })).toBe(
      "Saved a.mcap → captures",
    );
  });

  it("says how to resume, and that nothing was lost, when paused", () => {
    const text = saveStatusText({ mode: "paused" });
    expect(text).toContain("re-grant folder access");
    expect(text).toContain("still being cached");
  });

  it("includes the underlying error when a write fails", () => {
    expect(
      saveStatusText({ mode: "download", name: "a.mcap", reason: "error", error: "boom" }),
    ).toBe("Write failed (boom) — downloaded a.mcap");
  });
});

describe("statusFromResult", () => {
  it("pairs the text with its severity", () => {
    expect(statusFromResult({ mode: "paused" })).toEqual({
      text: saveStatusText({ mode: "paused" }),
      severity: "error",
    });
  });
});

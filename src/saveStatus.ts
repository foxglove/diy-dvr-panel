// How a save attempt is reported to the user.
//
// Kept pure and separate from the panel (the same reason `settings.ts` is), because the
// severity decision is the difference between a user noticing that data is not reaching
// disk and an unattended recording quietly dropping windows.

/** The outcome of one attempt to put a captured window somewhere durable. */
export type SaveResult =
  | { mode: "folder"; name: string; folder: string }
  | { mode: "paused" }
  | { mode: "download"; name: string; reason?: "denied" | "error"; error?: string };

/**
 * How loudly to report an outcome.
 *
 * - `ok` — it landed where the user asked.
 * - `warn` — it landed somewhere else (a browser download instead of the folder).
 * - `error` — it did not land at all.
 */
export type SaveSeverity = "ok" | "warn" | "error";

export type SaveStatus = { text: string; severity: SaveSeverity };

export function saveStatusText(result: SaveResult): string {
  switch (result.mode) {
    case "folder":
      return `Saved ${result.name} → ${result.folder}`;
    case "paused":
      return (
        "Auto-save to the folder is paused — re-grant folder access to resume. " +
        "Windows are still being cached."
      );
    case "download":
      if (result.reason === "denied") {
        return `Permission denied — downloaded ${result.name}`;
      }
      if (result.reason === "error") {
        return `Write failed (${result.error ?? ""}) — downloaded ${result.name}`;
      }
      return `Downloaded ${result.name}`;
  }
}

export function saveStatusSeverity(result: SaveResult): SaveSeverity {
  switch (result.mode) {
    case "folder":
      return "ok";
    // Nothing was written. A rotation has already dropped its window from the live ring,
    // so this is the case that most needs to be impossible to miss.
    case "paused":
      return "error";
    case "download":
      return result.reason == undefined ? "ok" : "warn";
  }
}

export function statusFromResult(result: SaveResult): SaveStatus {
  return { text: saveStatusText(result), severity: saveStatusSeverity(result) };
}

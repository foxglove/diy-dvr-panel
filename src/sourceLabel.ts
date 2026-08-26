// Best-effort guess at which data source a capture came from.
//
// A panel captures from the app's player rather than opening its own connection, and the
// extension API's `RenderState` carries no host, port or URL — only frames, topics, times and
// app settings. So there is nothing to ask. What the app *does* expose is its own address bar:
// with a live WebSocket source it encodes the source in a `ds.url` query parameter, so a panel
// running in that window can read it back out.
//
// That is a guess, not a fact — a desktop file, a recording, or a data-platform source has no
// such parameter — which is why the label it produces is only ever a default the user can
// replace.

/** Just the parts of `Location` this reads, so a test can hand it a string pair. */
export type LocationParts = { search: string; hash: string };

function currentLocation(): LocationParts {
  if (typeof window === "undefined") {
    return { search: "", hash: "" };
  }
  return { search: window.location.search, hash: window.location.hash };
}

/** The query portion of a `search` or `hash`, with any leading `?`, `#` or route stripped. */
function queryOf(part: string): string {
  const body = part.startsWith("?") || part.startsWith("#") ? part.slice(1) : part;
  const questionMark = body.indexOf("?");
  return questionMark >= 0 ? body.slice(questionMark + 1) : body;
}

/**
 * The data-source URL the app is showing, or `""` when it cannot be told.
 *
 * Checks the hash as well as the query string, since the app may route through either. Never
 * throws: a label is a nicety, and nothing here is worth failing a capture over.
 */
export function detectSourceLabel(location: LocationParts = currentLocation()): string {
  try {
    for (const part of [location.search, location.hash]) {
      if (part.length === 0) {
        continue;
      }
      // URLSearchParams percent-decodes on read, so `ws%3A%2F%2Flocalhost%3A9000` comes back
      // as `ws://localhost:9000`. Decoding again would corrupt a legitimately escaped `%25`.
      const url = new URLSearchParams(queryOf(part)).get("ds.url");
      if (url != undefined && url.trim().length > 0) {
        return url.trim();
      }
    }
  } catch {
    // A malformed location is not worth reporting; fall through to no label.
  }
  return "";
}

/**
 * The label to stamp on new clips: the user's own wording if they gave one, otherwise whatever
 * could be detected, otherwise nothing.
 */
export function effectiveSourceLabel(configured: string, detected: string): string {
  const chosen = configured.trim();
  return chosen.length > 0 ? chosen : detected;
}

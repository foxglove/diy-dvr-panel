// Shared clip vocabulary: imported by the capture engine, the worker adapter, the
// OPFS store, and the panel. Types only — nothing here has a runtime footprint.

/**
 * Why a clip was captured.
 *
 * - `gap` — no message arrived for longer than the configured gap threshold.
 * - `backgrounded` — the tab was hidden.
 * - `closing` — the tab / app is going away (best effort).
 * - `manual-clip` — the user pressed "Cache clip".
 * - `rotation` — an auto-save window that filled up. The window is cleared from the live
 *   ring as it rotates, so caching it is what makes the data survive a folder write that
 *   cannot complete (a lapsed write permission pauses the write, and there is no gesture
 *   in that code path to re-request one).
 * - `recovered` — promoted from an un-sealed mirror left behind by a previous worker
 *   (a crash, or the `initPanel` teardown that happens on a reconnect). Only the latest
 *   one is kept, and it is evicted ahead of anything the user asked for.
 */
export type ClipTrigger =
  | "gap"
  | "backgrounded"
  | "closing"
  | "manual-clip"
  | "rotation"
  | "recovered";

/** Triggers the panel can ask for directly. */
export type PanelTrigger = "backgrounded" | "closing" | "manual-clip";

/**
 * Everything known about one cached clip. Written to OPFS as a JSON sidecar next to the
 * MCAP bytes, and broadcast to the panel verbatim.
 *
 * Nanosecond timestamps are decimal *strings*, not `bigint`: this record is
 * JSON-serialized into the sidecar and `JSON.stringify` cannot handle a bigint. It also
 * matches the worker's existing `stat` message, which reports nanos as strings.
 */
export type ClipMeta = {
  /** Stable id, also the OPFS filename stem. */
  id: string;
  trigger: ClipTrigger;
  /** Display label for the trigger, e.g. `gap>10s`. */
  triggerLabel: string;
  /** logTime of the oldest buffered message, in nanoseconds. */
  startNanos: string;
  /** logTime of the newest buffered message, in nanoseconds. */
  endNanos: string;
  /** `endNanos - startNanos`, in seconds, floored at zero. */
  durationSec: number;
  /** Size of the framed MCAP, in bytes. Drives cache eviction. */
  byteSize: number;
  /** Total messages in the clip (the sum of `topicCounts`). */
  messageCount: number;
  /** Per-topic message counts within the clip. */
  topicCounts: Record<string, number>;
  /** Wall-clock ms when the clip was captured. The FIFO ordering key. */
  createdAt: number;
  /** False only for the live mirror, which is still being updated. */
  sealed: boolean;
};

// Shared clip vocabulary: imported by the capture engine, the worker adapter, the OPFS
// store, and the panel.
//
// Mostly types. The one piece of logic here is the eviction plan, which both sides need and
// must agree on: the worker executes it, and the panel previews it to say how many clips a
// lower cache limit would drop. It lives here rather than in `captureEngine.ts` so the panel
// can use it without pulling the MCAP writer into its bundle.

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
  /**
   * Per-topic encoded payload bytes within the clip. Optional because clips cached by an
   * earlier build have no such field in their sidecar; those show counts only.
   *
   * This is what makes a runaway topic self-diagnosing. A user script that republishes a
   * growing history (a breadcrumb trail, say) keeps its message *count* flat while its
   * payload balloons, so counts alone cannot explain a clip that tripled in size.
   */
  topicBytes?: Record<string, number>;
  /** Wall-clock ms when the clip was captured. The FIFO ordering key. */
  createdAt: number;
  /** False only for the live mirror, which is still being updated. */
  sealed: boolean;
};

/**
 * Eviction order: `recovered` clips first, then oldest first.
 *
 * A recovered clip is churn produced by reconnecting, not something the user asked for, so it
 * goes ahead of any `gap`, `manual`, or auto-save window however new it is.
 */
function compareEvictionOrder(a: ClipMeta, b: ClipMeta): number {
  const aRank = a.trigger === "recovered" ? 0 : 1;
  const bRank = b.trigger === "recovered" ? 0 : 1;
  if (aRank !== bRank) {
    return aRank - bRank;
  }
  return a.createdAt - b.createdAt;
}

/**
 * Which clips have to go for the cache to fit `capBytes`, in the order they would be dropped.
 *
 * At least one clip is always kept, so a single clip larger than the cap survives rather than
 * being written and immediately deleted.
 *
 * The worker runs this to evict; the panel runs it to tell the user what lowering the limit
 * would cost before it happens.
 */
export function planEviction(clips: readonly ClipMeta[], capBytes: number): ClipMeta[] {
  let total = clips.reduce((sum, clip) => sum + clip.byteSize, 0);
  let remaining = clips.length;
  const doomed: ClipMeta[] = [];
  for (const clip of [...clips].sort(compareEvictionOrder)) {
    if (total <= capBytes || remaining <= 1) {
      break;
    }
    doomed.push(clip);
    total -= clip.byteSize;
    remaining--;
  }
  return doomed;
}

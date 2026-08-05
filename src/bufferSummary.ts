// How the live buffer is described in the panel.
//
// Kept pure and separate from the component (the same reason `settings.ts` and `saveStatus.ts`
// are) so the wording and the rounding are directly testable — the readout is the only thing
// telling an unattended user what the panel is holding, and it has been wrong twice.

import { BudgetMode } from "./settings";

/** Just the fields of the worker's stat message these summaries read. */
export type BufferStat = {
  bufferedMsgs: number;
  byteTotal: number;
  /** Arrival times, so the reported span stays meaningful on a looping or replayed source. */
  oldestNanos: string;
  newestNanos: string;
};

/**
 * The pinned one-liner.
 *
 * Being subscribed to topics is not the same as receiving data, so this does not claim to be
 * recording until something is actually buffered — the headline state has to be honest about a
 * source that is connected but silent.
 */
export function bufferStatus(
  stat: BufferStat,
  flags: { workerReady: boolean; enabledTopics: number },
): { label: string; active: boolean } {
  if (!flags.workerReady) {
    return { label: "Starting…", active: false };
  }
  if (flags.enabledTopics === 0) {
    return { label: "No topics selected", active: false };
  }
  if (stat.bufferedMsgs === 0) {
    return { label: "Waiting for data", active: false };
  }
  return { label: "Recording", active: true };
}

/** `budget` is the lookback actually in force — the settled value, not a half-typed one. */
export function statSummary(
  stat: BufferStat,
  budget: { mode: BudgetMode; value: number },
): { used: string; cap: string } {
  if (budget.mode === "time") {
    const spanNanos = BigInt(stat.newestNanos) - BigInt(stat.oldestNanos);
    // Floor at zero so a transient backward time jump can never render negative.
    const usedSec = stat.bufferedMsgs > 0 ? Math.max(0, Number(spanNanos) / 1e9) : 0;
    // Whole seconds, because tenths made the pinned readout visibly twitch on a busy stream —
    // but rounded *up*, and clamped to the budget. At steady state the ring evicts to keep its
    // span just under the budget, so it sits at ~59.x of 60 forever; rounding down would peg the
    // readout at 59s and never show the window as full. The clamp keeps a span that is briefly
    // over budget (a message landing before eviction runs) from reading 61s / 60s.
    const used = Math.min(budget.value, Math.ceil(usedSec));
    return { used: `${used}s`, cap: `${budget.value}s` };
  }
  const usedMb = stat.byteTotal / (1024 * 1024);
  return { used: `${usedMb.toFixed(2)} MB`, cap: `${budget.value} MB` };
}

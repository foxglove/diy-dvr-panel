// Small pure helpers shared by the capture path: a promise timeout, the time conversion the
// ring keys on, and two byte-level utilities. Split out of `captureEngine.ts` so each can be
// read and tested without standing up an engine.

import { DvrRecord } from "./buildMcap";

export type Time = { sec: number; nsec: number };

/** Reject if `work` has not settled within `ms`. The timer is always cleared. */
export async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  // Collected rather than held in a `let`, so the always-run cleanup does not depend on
  // control-flow analysis reaching into the executor.
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timers.push(
          setTimeout(() => {
            reject(new Error(`Timed out trying to ${what}`));
          }, ms),
        );
      }),
    ]);
  } finally {
    for (const timer of timers) {
      clearTimeout(timer);
    }
  }
}

/** Total encoded payload bytes in a snapshot: a close, cheap proxy for its framed size. */
export function payloadBytes(records: readonly DvrRecord[]): number {
  return records.reduce((total, record) => total + record.data.byteLength, 0);
}

export function toNanos(time?: Time): bigint {
  if (time == undefined) {
    return 0n;
  }
  return BigInt(time.sec) * 1_000_000_000n + BigInt(time.nsec);
}

/** Detach a view into its own transferable ArrayBuffer. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

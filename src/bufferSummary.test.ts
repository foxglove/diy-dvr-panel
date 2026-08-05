import { BufferStat, bufferStatus, statSummary } from "./bufferSummary";

/** A stat whose window spans `spanSec`, as the worker would report it. */
function stat(spanSec: number, overrides: Partial<BufferStat> = {}): BufferStat {
  const start = 1_700_000_000_000_000_000n;
  return {
    bufferedMsgs: 100,
    byteTotal: 0,
    oldestNanos: start.toString(),
    newestNanos: (start + BigInt(Math.round(spanSec * 1e9))).toString(),
    ...overrides,
  };
}

const sixtySeconds = { mode: "time" as const, value: 60 };

describe("statSummary — time mode", () => {
  it("reads as full once the window is nearly at the budget", () => {
    // At steady state the ring evicts to keep its span just *under* the budget, so it sits at
    // ~59.x of 60 indefinitely. Rounding down pinned the readout at 59s and it never showed the
    // window as full.
    expect(statSummary(stat(59.4), sixtySeconds).used).toBe("60s");
    expect(statSummary(stat(59.99), sixtySeconds).used).toBe("60s");
  });

  it("clamps a span that is briefly over budget", () => {
    // A message can land before eviction runs; the readout must not claim 61s of a 60s window.
    expect(statSummary(stat(60.2), sixtySeconds).used).toBe("60s");
    expect(statSummary(stat(75), sixtySeconds).used).toBe("60s");
  });

  it("reads zero for an empty buffer", () => {
    expect(statSummary(stat(0, { bufferedMsgs: 0 }), sixtySeconds).used).toBe("0s");
    // Even if stale nanos suggest a span, no buffered messages means no window.
    expect(statSummary(stat(30, { bufferedMsgs: 0 }), sixtySeconds).used).toBe("0s");
  });

  it("rounds a partly-filled window up to the next second", () => {
    expect(statSummary(stat(0.2), sixtySeconds).used).toBe("1s");
    expect(statSummary(stat(12.1), sixtySeconds).used).toBe("13s");
    expect(statSummary(stat(30), sixtySeconds).used).toBe("30s");
  });

  it("never renders a negative span", () => {
    // A source that jumps its clock backwards can momentarily report newest < oldest.
    const backwards = stat(0, {
      newestNanos: "1699999999000000000",
      oldestNanos: "1700000000000000000",
    });
    expect(statSummary(backwards, sixtySeconds).used).toBe("0s");
  });

  it("reports the cap it was given", () => {
    expect(statSummary(stat(10), { mode: "time", value: 45 })).toEqual({ used: "10s", cap: "45s" });
  });
});

describe("statSummary — bytes mode", () => {
  it("reports megabytes to two places, unchanged", () => {
    const summary = statSummary(stat(0, { byteTotal: 3.5 * 1024 * 1024 }), {
      mode: "bytes",
      value: 512,
    });
    expect(summary).toEqual({ used: "3.50 MB", cap: "512 MB" });
  });

  it("does not clamp bytes to the cap", () => {
    // Only the seconds readout is clamped; a byte overshoot is worth seeing.
    const summary = statSummary(stat(0, { byteTotal: 600 * 1024 * 1024 }), {
      mode: "bytes",
      value: 512,
    });
    expect(summary.used).toBe("600.00 MB");
  });
});

describe("bufferStatus", () => {
  it("waits for the worker before claiming anything", () => {
    expect(bufferStatus(stat(0), { workerReady: false, enabledTopics: 3 })).toEqual({
      label: "Starting…",
      active: false,
    });
  });

  it("distinguishes no topics from no data", () => {
    expect(
      bufferStatus(stat(0, { bufferedMsgs: 0 }), { workerReady: true, enabledTopics: 0 }),
    ).toEqual({ label: "No topics selected", active: false });
    expect(
      bufferStatus(stat(0, { bufferedMsgs: 0 }), { workerReady: true, enabledTopics: 3 }),
    ).toEqual({ label: "Waiting for data", active: false });
  });

  it("only says recording once something is buffered", () => {
    expect(bufferStatus(stat(5), { workerReady: true, enabledTopics: 3 })).toEqual({
      label: "Recording",
      active: true,
    });
  });
});

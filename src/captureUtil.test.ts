import { DvrRecord } from "./buildMcap";
import { payloadBytes, toArrayBuffer, toNanos, withTimeout } from "./captureUtil";

/** A ring record carrying `size` payload bytes; only `data` matters to `payloadBytes`. */
function record(size: number): DvrRecord {
  return {
    topic: "/a",
    logTime: 0n,
    publishTime: 0n,
    arrivalNanos: 0n,
    data: new Uint8Array(size),
  };
}

describe("toNanos", () => {
  it("treats a missing time as zero", () => {
    expect(toNanos()).toBe(0n);
    expect(toNanos(undefined)).toBe(0n);
  });

  it("combines seconds and nanoseconds", () => {
    expect(toNanos({ sec: 3, nsec: 250 })).toBe(3_000_000_250n);
    expect(toNanos({ sec: 0, nsec: 0 })).toBe(0n);
  });

  it("keeps full precision past the double-safe range", () => {
    // 1.7e18 ns is inside a normal wall-clock capture and well past Number.MAX_SAFE_INTEGER.
    expect(toNanos({ sec: 1_700_000_000, nsec: 123_456_789 })).toBe(1_700_000_000_123_456_789n);
  });
});

describe("withTimeout", () => {
  /** Work that never settles, so only the timer can decide the race. */
  const stalled = new Promise<never>(() => undefined);

  /**
   * Run `work` past its deadline and hand back however it settled. The rejection is captured as
   * a value, so nothing is left unhandled while the timers are advanced.
   */
  async function raceTheTimer(work: Promise<never>, what: string): Promise<unknown> {
    const outcome = withTimeout(work, 1000, what).catch((err: unknown) => err);
    await jest.advanceTimersByTimeAsync(1000);
    return await outcome;
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("resolves with the work's value when the work wins", async () => {
    await expect(withTimeout(Promise.resolve("done"), 1000, "open the clip cache")).resolves.toBe(
      "done",
    );
  });

  it("names what timed out when the timer wins", async () => {
    const err = await raceTheTimer(stalled, "open the clip cache");
    expect(err).toEqual(new Error("Timed out trying to open the clip cache"));
  });

  it("leaves no timer behind either way", async () => {
    await withTimeout(Promise.resolve(1), 1000, "win");
    expect(jest.getTimerCount()).toBe(0);

    await raceTheTimer(stalled, "lose");
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe("payloadBytes", () => {
  it("sums the encoded payloads", () => {
    expect(payloadBytes([record(10), record(32), record(0)])).toBe(42);
  });

  it("is zero for an empty snapshot", () => {
    expect(payloadBytes([])).toBe(0);
  });
});

describe("toArrayBuffer", () => {
  it("copies just the view's own window", () => {
    const backing = new Uint8Array([1, 2, 3, 4, 5]);
    const view = backing.subarray(1, 4);
    const detached = toArrayBuffer(view);
    expect(new Uint8Array(detached)).toEqual(new Uint8Array([2, 3, 4]));
  });

  it("is detached from the source, so a later write cannot reach it", () => {
    const backing = new Uint8Array([1, 2, 3]);
    const detached = toArrayBuffer(backing);
    backing[0] = 99;
    expect(new Uint8Array(detached)[0]).toBe(1);
  });
});

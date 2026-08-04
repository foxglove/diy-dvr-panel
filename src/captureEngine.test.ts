// Unit tests for the capture core. No DOM, no Worker, no Foxglove app: the engine takes
// an injected store, clock, output sink, and MCAP framer, so everything below is plain
// TypeScript running in Node.

import { buildMcap, DvrRecord } from "./buildMcap";
import { CaptureEngine, EngineConfig, FrameFn } from "./captureEngine";
import { ClipMeta } from "./clipTypes";
import { ClipStore } from "./opfsStore";
import {
  blockingFrame,
  collectOutputs,
  createFakeBacking,
  createFakeClipStore,
  createFakeClock,
  FakeBacking,
  FakeClock,
  FakeStoreOptions,
  makeMirrorMeta,
  makeMsg,
  nanosOf,
  OutputCollector,
  sizedFrame,
} from "./testFakes";

/** Longer than any clock advance in these tests, so the mirror stays out of the way. */
const NO_MIRROR = 1_000_000_000;

const MCAP_MAGIC = [0x89, 0x4d, 0x43, 0x41, 0x50, 0x30];

type Harness = {
  engine: CaptureEngine;
  clock: FakeClock;
  backing: FakeBacking;
  store: ClipStore;
  out: OutputCollector;
};

function harness(
  opts: {
    backing?: FakeBacking;
    clock?: FakeClock;
    frame?: FrameFn;
    mirrorIntervalMs?: number;
    initTimeoutMs?: number;
    storeOptions?: FakeStoreOptions;
  } = {},
): Harness {
  const backing = opts.backing ?? createFakeBacking();
  const clock = opts.clock ?? createFakeClock();
  const store = createFakeClipStore(backing, opts.storeOptions);
  const out = collectOutputs();
  const engine = new CaptureEngine({
    store,
    now: clock.now,
    emit: out.emit,
    frame: opts.frame ?? sizedFrame(128),
    mirrorIntervalMs: opts.mirrorIntervalMs ?? NO_MIRROR,
    initTimeoutMs: opts.initTimeoutMs,
    // Retry backoff without real timers.
    delay: async () => {
      await Promise.resolve();
    },
  });
  return { engine, clock, backing, store, out };
}

/** Seed a sealed clip straight into the backing, bypassing the engine. */
function seedClip(
  backing: FakeBacking,
  overrides: Partial<ClipMeta> & Pick<ClipMeta, "id" | "trigger" | "createdAt">,
): void {
  const meta: ClipMeta = {
    triggerLabel: overrides.trigger,
    startNanos: "0",
    endNanos: "0",
    durationSec: 0,
    byteSize: 100,
    messageCount: 1,
    topicCounts: { "/a": 1 },
    sealed: true,
    ...overrides,
  };
  backing.clips.set(meta.id, { meta, bytes: new Uint8Array(meta.byteSize) });
}

function config(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    budgetMode: "time",
    budgetNanos: 3600n * 1_000_000_000n,
    autoSave: false,
    enabledTopics: [],
    ...overrides,
  };
}

/** Let queued microtasks run without waiting for a promise that never settles. */
async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

function storedClips(backing: FakeBacking): ClipMeta[] {
  return Array.from(backing.clips.values())
    .map((entry) => entry.meta)
    .sort((a, b) =>
      a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt - b.createdAt,
    );
}

describe("live ring buffer", () => {
  it("evicts the oldest record once the time budget is exceeded", async () => {
    const { engine } = harness();
    engine.start();
    engine.configure(config({ budgetNanos: 5n * 1_000_000_000n }));
    for (let sec = 100; sec <= 109; sec++) {
      engine.addMessage(makeMsg("/a", sec));
    }
    await engine.whenIdle();

    const records = engine.bufferedRecords();
    // 109 - 104 == 5s, so 104 is the oldest record that still fits the budget.
    expect(records[0]?.logTime).toBe(nanosOf(104));
    expect(records[records.length - 1]?.logTime).toBe(nanosOf(109));
    const span = nanosOf(109) - nanosOf(104);
    expect(span).toBeLessThanOrEqual(5n * 1_000_000_000n);
    // Every message was counted even though older ones rolled off.
    expect(engine.stats().messageCount).toBe(10);
  });

  it("evicts the oldest record once the byte budget is exceeded", async () => {
    const { engine } = harness();
    engine.start();
    engine.configure(config({ budgetMode: "bytes", budgetBytes: 40 }));
    for (let sec = 100; sec <= 109; sec++) {
      engine.addMessage(makeMsg("/a", sec));
    }
    await engine.whenIdle();

    const stats = engine.stats();
    expect(stats.byteTotal).toBeLessThanOrEqual(40);
    expect(stats.bufferedMsgs).toBeGreaterThan(0);
    expect(stats.bufferedMsgs).toBeLessThan(10);
    // The window kept the newest messages and dropped the oldest.
    expect(engine.bufferedRecords()[0]?.logTime).toBeGreaterThan(nanosOf(100));
    expect(stats.newestNanos).toBe(nanosOf(109).toString());
  });

  it("keeps records sorted when a source delivers times out of order", () => {
    const { engine } = harness();
    engine.configure(config());
    engine.addMessage(makeMsg("/a", 100));
    engine.addMessage(makeMsg("/a", 102));
    engine.addMessage(makeMsg("/a", 101));

    const times = engine.bufferedRecords().map((record) => record.logTime);
    expect(times).toEqual([nanosOf(100), nanosOf(101), nanosOf(102)]);
    const stats = engine.stats();
    expect(stats.oldestNanos).toBe(nanosOf(100).toString());
    expect(stats.newestNanos).toBe(nanosOf(102).toString());
  });

  it("reports a stat on the tick when the buffer changed, and only then", () => {
    // The panel pins a live buffer status, and the every-200-messages cadence alone can
    // lag for minutes on a slow feed.
    const { engine, out } = harness();
    engine.configure(config());
    out.clear();

    engine.tick();
    expect(out.all("stat")).toHaveLength(0);

    engine.addMessage(makeMsg("/a", 100));
    engine.tick();
    expect(out.all("stat")).toHaveLength(1);
    expect(out.last("stat")?.bufferedMsgs).toBe(1);

    // Nothing new arrived, so there is nothing to report.
    engine.tick();
    engine.tick();
    expect(out.all("stat")).toHaveLength(1);

    engine.addMessage(makeMsg("/a", 101));
    engine.tick();
    expect(out.all("stat")).toHaveLength(2);
    expect(out.last("stat")?.bufferedMsgs).toBe(2);
  });

  it("frames the current window on save without clearing it", async () => {
    const { engine, out } = harness();
    engine.configure(config());
    engine.addMessage(makeMsg("/a", 100));
    engine.addMessage(makeMsg("/a", 101));
    engine.save();
    await engine.whenIdle();
    await flushMicrotasks();

    const saved = out.last("saved");
    expect(saved?.rotation).toBe(false);
    expect(saved?.buffer.byteLength).toBe(128);
    expect(engine.bufferedRecords()).toHaveLength(2);
  });
});

describe("clip triggers", () => {
  it("fires a gap clip once, then re-arms on the next message", async () => {
    const { engine, clock, backing } = harness();
    engine.start();
    engine.configure(config({ gapMs: 10_000 }));
    engine.addMessage(makeMsg("/a", 100));
    await engine.whenIdle();

    // Not yet: the gap threshold has not elapsed.
    clock.advance(9_000);
    engine.tick();
    await engine.whenIdle();
    expect(backing.clips.size).toBe(0);

    clock.advance(2_000);
    engine.tick();
    await engine.whenIdle();
    expect(backing.clips.size).toBe(1);
    expect(storedClips(backing)[0]).toMatchObject({
      trigger: "gap",
      triggerLabel: "gap>10s",
      sealed: true,
    });

    // Still one: a single gap fires exactly one clip however long it lasts.
    clock.advance(60_000);
    engine.tick();
    await engine.whenIdle();
    expect(backing.clips.size).toBe(1);

    // Traffic resumes, then stops again: the trigger re-arms.
    engine.addMessage(makeMsg("/a", 200));
    clock.advance(11_000);
    engine.tick();
    await engine.whenIdle();
    expect(backing.clips.size).toBe(2);

    // The live ring was never reset by snapshotting.
    expect(engine.bufferedRecords()).toHaveLength(2);
    expect(engine.stats().messageCount).toBe(2);
  });

  it("never fires a gap clip before the first message", async () => {
    const { engine, clock, backing } = harness();
    engine.start();
    engine.configure(config({ gapMs: 10_000 }));
    clock.advance(600_000);
    engine.tick();
    await engine.whenIdle();
    expect(backing.clips.size).toBe(0);
  });

  it("treats a zero gap threshold as disabled", async () => {
    const { engine, clock, backing } = harness();
    engine.start();
    engine.configure(config({ gapMs: 0 }));
    engine.addMessage(makeMsg("/a", 100));
    clock.advance(600_000);
    engine.tick();
    await engine.whenIdle();
    expect(backing.clips.size).toBe(0);
  });

  it.each([
    ["backgrounded", "backgrounded"],
    ["closing", "closing"],
    ["manual-clip", "manual"],
  ] as const)("captures a clip on the %s trigger", async (trigger, label) => {
    const { engine, backing } = harness();
    engine.start();
    engine.configure(config());
    engine.addMessage(makeMsg("/a", 100));
    engine.addMessage(makeMsg("/a", 101));
    const before = engine.stats();

    engine.createClip(trigger);
    await engine.whenIdle();

    expect(backing.clips.size).toBe(1);
    expect(storedClips(backing)[0]).toMatchObject({ trigger, triggerLabel: label, sealed: true });
    // Snapshotting is non-destructive.
    expect(engine.stats().bufferedMsgs).toBe(before.bufferedMsgs);
    expect(engine.stats().byteTotal).toBe(before.byteTotal);
  });

  it("writes nothing when the buffer is empty", async () => {
    const { engine, backing, out } = harness();
    engine.start();
    engine.configure(config());
    out.clear();

    engine.createClip("manual-clip");
    engine.createClip("backgrounded");
    await engine.whenIdle();

    expect(backing.clips.size).toBe(0);
    expect(out.all("error")).toHaveLength(0);
  });

  it("keeps cached clips when the live buffer is reset", async () => {
    const { engine, backing } = harness();
    engine.start();
    engine.configure(config());
    engine.addMessage(makeMsg("/a", 100));
    engine.createClip("manual-clip");
    await engine.whenIdle();

    engine.reset();
    expect(engine.bufferedRecords()).toHaveLength(0);
    expect(backing.clips.size).toBe(1);
  });
});

describe("auto-save rotation", () => {
  it("caches the rotated window as well as handing it to the panel", async () => {
    // The rotation has already dropped the window from the live ring, and the folder write
    // pauses whenever the directory's read-write grant has lapsed — which it does on every
    // page load. Without a cached copy the window is simply gone.
    const { engine, backing, out } = harness({ frame: sizedFrame(512) });
    engine.start();
    engine.configure(config({ budgetNanos: 5n * 1_000_000_000n, autoSave: true }));
    for (let sec = 100; sec <= 110; sec++) {
      engine.addMessage(makeMsg("/a", sec));
    }
    await engine.whenIdle();

    const clips = storedClips(backing);
    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({
      trigger: "rotation",
      triggerLabel: "auto-save",
      sealed: true,
      byteSize: 512,
    });
    // The rotation still reaches the panel for the opportunistic folder write.
    expect(out.last("saved")?.rotation).toBe(true);
    expect(engine.stats().rotations).toBeGreaterThan(0);
  });

  it("does not cache anything when auto-save is off", async () => {
    const { engine, backing, out } = harness();
    engine.start();
    engine.configure(config({ budgetNanos: 5n * 1_000_000_000n, autoSave: false }));
    for (let sec = 100; sec <= 110; sec++) {
      engine.addMessage(makeMsg("/a", sec));
    }
    await engine.whenIdle();

    expect(backing.clips.size).toBe(0);
    expect(out.all("saved")).toHaveLength(0);
  });

  it("keeps rotation windows at the same eviction priority as user clips", async () => {
    // An auto-save window is data the user asked to keep, so it must not be treated as
    // churn the way a recovered clip is.
    const backing = createFakeBacking();
    seedClip(backing, { id: "rot", trigger: "rotation", createdAt: 1000, byteSize: 100 });
    seedClip(backing, { id: "rec", trigger: "recovered", createdAt: 5000, byteSize: 100 });
    const { engine } = harness({ backing });
    engine.start();
    engine.configure(config({ maxCacheBytes: 150 }));
    await engine.whenIdle();

    // The newer recovered clip goes even though the rotation window is older.
    expect(storedClips(backing).map((clip) => clip.id)).toEqual(["rot"]);
  });
});

describe("rehydrate resilience", () => {
  it("retries a transient failure and still loads the clips", async () => {
    const backing = createFakeBacking();
    seedClip(backing, { id: "a", trigger: "gap", createdAt: 1000 });
    const { engine, out } = harness({
      backing,
      storeOptions: { failListClipsTimes: 1 },
    });
    engine.start();
    await engine.whenIdle();

    expect(out.last("clips")?.clips.map((clip) => clip.id)).toEqual(["a"]);
    expect(out.all("error")).toHaveLength(0);
  });

  it("still broadcasts when a rehydrate step keeps failing", async () => {
    // A throw used to skip the broadcast entirely, leaving the panel on its empty initial
    // list until the next mutation — cached clips looked lost.
    const backing = createFakeBacking();
    seedClip(backing, { id: "a", trigger: "gap", createdAt: 1000 });
    const { engine, out } = harness({
      backing,
      storeOptions: { failListClipsTimes: 99 },
    });
    engine.start();
    await engine.whenIdle();

    expect(out.last("clips")).toBeDefined();
    expect(out.last("error")?.message).toContain("read the cached clips");
    // And the failure is reported once, not per retry.
    expect(out.all("error")).toHaveLength(1);
  });

  it("still broadcasts when session recovery fails", async () => {
    const backing = createFakeBacking();
    seedClip(backing, { id: "a", trigger: "manual-clip", createdAt: 1000 });
    const { engine, out } = harness({ backing, storeOptions: { failOrphanMirrors: true } });
    engine.start();
    await engine.whenIdle();

    // The clips that did load are still shown.
    expect(out.last("clips")?.clips.map((clip) => clip.id)).toEqual(["a"]);
    expect(out.last("error")?.message).toContain("recover the previous session");
  });
});

describe("recovered-clip churn", () => {
  it("keeps only the latest recovered clip", async () => {
    // Every reload and reconnect promotes the previous worker's mirror. Left alone they
    // accumulate and start pushing real clips out of the cache.
    const backing = createFakeBacking();
    seedClip(backing, { id: "old-rec-1", trigger: "recovered", createdAt: 1000 });
    seedClip(backing, { id: "old-rec-2", trigger: "recovered", createdAt: 2000 });
    seedClip(backing, { id: "real", trigger: "gap", createdAt: 1500 });
    backing.mirrors.set("dead-worker", {
      meta: makeMirrorMeta({ messageCount: 3 }),
      bytes: new Uint8Array([1, 2, 3]),
    });

    const { engine } = harness({ backing, storeOptions: { instanceId: "live-worker" } });
    engine.start();
    await engine.whenIdle();

    const kept = storedClips(backing);
    const recovered = kept.filter((clip) => clip.trigger === "recovered");
    expect(recovered).toHaveLength(1);
    // The survivor is the one just promoted, not an older leftover.
    expect(recovered[0]?.id).not.toBe("old-rec-1");
    expect(recovered[0]?.id).not.toBe("old-rec-2");
    // The user's clip is untouched.
    expect(kept.some((clip) => clip.id === "real")).toBe(true);
  });

  it("evicts a recovered clip before any clip the user asked for", async () => {
    const backing = createFakeBacking();
    // The recovered clip is the newest, so plain oldest-first eviction would spare it and
    // drop the user's clips instead.
    seedClip(backing, { id: "gap-old", trigger: "gap", createdAt: 1000, byteSize: 100 });
    seedClip(backing, { id: "manual", trigger: "manual-clip", createdAt: 2000, byteSize: 100 });
    seedClip(backing, { id: "recovered", trigger: "recovered", createdAt: 9000, byteSize: 100 });

    const { engine } = harness({ backing });
    engine.start();
    engine.configure(config({ maxCacheBytes: 250 }));
    await engine.whenIdle();

    expect(storedClips(backing).map((clip) => clip.id)).toEqual(["gap-old", "manual"]);
  });

  it("still keeps one clip when only recovered clips remain", async () => {
    const backing = createFakeBacking();
    seedClip(backing, { id: "rec-1", trigger: "recovered", createdAt: 1000, byteSize: 100 });
    seedClip(backing, { id: "rec-2", trigger: "recovered", createdAt: 2000, byteSize: 100 });

    const { engine } = harness({ backing });
    engine.start();
    engine.configure(config({ maxCacheBytes: 50 }));
    await engine.whenIdle();

    expect(storedClips(backing)).toHaveLength(1);
  });
});

describe("clip metadata", () => {
  it("records per-topic message counts, size, and span", async () => {
    const { engine, backing, clock } = harness({ frame: sizedFrame(4096) });
    engine.start();
    engine.configure(config());
    engine.addMessage(makeMsg("/a", 100));
    engine.addMessage(makeMsg("/a", 101));
    engine.addMessage(makeMsg("/a", 102));
    engine.addMessage(makeMsg("/b", 103));
    engine.addMessage(makeMsg("/b", 104));

    engine.createClip("manual-clip");
    await engine.whenIdle();

    const meta = storedClips(backing)[0];
    expect(meta?.topicCounts).toEqual({ "/a": 3, "/b": 2 });
    expect(meta?.messageCount).toBe(5);
    expect(meta?.byteSize).toBe(4096);
    expect(meta?.startNanos).toBe(nanosOf(100).toString());
    expect(meta?.endNanos).toBe(nanosOf(104).toString());
    expect(meta?.durationSec).toBeCloseTo(4, 6);
    expect(meta?.createdAt).toBe(clock.now());
  });

  it("frames a real indexed MCAP with the default framer", async () => {
    const backing = createFakeBacking();
    const clock = createFakeClock();
    const out = collectOutputs();
    // No `frame` override: this exercises the real buildMcap + schema inference.
    const engine = new CaptureEngine({
      store: createFakeClipStore(backing),
      now: clock.now,
      emit: out.emit,
      mirrorIntervalMs: NO_MIRROR,
    });
    engine.start();
    engine.configure(config());
    engine.addMessage(makeMsg("/a", 100, { message: { value: 1, nested: { flag: true } } }));
    engine.addMessage(makeMsg("/b", 101, { message: { text: "hello" } }));

    engine.createClip("manual-clip");
    await engine.whenIdle();

    const stored = Array.from(backing.clips.values())[0];
    expect(stored).toBeDefined();
    expect(Array.from(stored?.bytes.subarray(0, 6) ?? [])).toEqual(MCAP_MAGIC);
    expect(stored?.meta.byteSize).toBe(stored?.bytes.byteLength);
    expect(stored?.meta.topicCounts).toEqual({ "/a": 1, "/b": 1 });
  });
});

describe("durability across a worker teardown", () => {
  it("rehydrates the cached clip list into a fresh engine", async () => {
    const backing = createFakeBacking();
    const clock = createFakeClock();

    // The worker that gets terminated.
    const first = harness({ backing, clock, storeOptions: { instanceId: "dead-worker" } });
    first.engine.start();
    first.engine.configure(config());
    first.engine.addMessage(makeMsg("/a", 100));
    first.engine.createClip("manual-clip");
    await first.engine.whenIdle();
    clock.advance(1000);
    first.engine.createClip("backgrounded");
    await first.engine.whenIdle();
    const writtenIds = storedClips(backing).map((clip) => clip.id);
    expect(writtenIds).toHaveLength(2);

    // A brand-new worker instance over the same origin storage.
    const second = harness({ backing, clock, storeOptions: { instanceId: "live-worker" } });
    second.engine.start();
    await second.engine.whenIdle();

    const broadcast = second.out.last("clips");
    expect(broadcast?.clips.map((clip) => clip.id)).toEqual(writtenIds);
    expect(broadcast?.cache).toEqual({ available: true, mode: "async" });
  });

  it("never derives the same clip id in two workers sharing the cache", async () => {
    // Two DIY DVR panels in one layout share the origin's cache, and both react to the
    // same event at the same instant from the same clip count. Ids must still differ, or
    // they collide on one file — which OPFS rejects and which would lose a clip.
    const backing = createFakeBacking();
    const clock = createFakeClock();
    const a = harness({ backing, clock, storeOptions: { instanceId: "worker-a" } });
    const b = harness({ backing, clock, storeOptions: { instanceId: "worker-b" } });
    for (const panel of [a, b]) {
      panel.engine.start();
      panel.engine.configure(config());
      panel.engine.addMessage(makeMsg("/a", 100));
    }
    await a.engine.whenIdle();
    await b.engine.whenIdle();

    // Same trigger, same millisecond, same starting sequence number.
    a.engine.createClip("backgrounded");
    b.engine.createClip("backgrounded");
    await a.engine.whenIdle();
    await b.engine.whenIdle();

    const ids = storedClips(backing).map((clip) => clip.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("promotes an un-sealed mirror left behind by a dead worker", async () => {
    const backing = createFakeBacking();
    backing.mirrors.set("dead-worker", {
      meta: makeMirrorMeta({ messageCount: 3, topicCounts: { "/a": 2, "/b": 1 } }),
      bytes: new Uint8Array([1, 2, 3, 4]),
    });

    const { engine, out } = harness({ backing, storeOptions: { instanceId: "live-worker" } });
    engine.start();
    await engine.whenIdle();

    const clips = storedClips(backing);
    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({
      trigger: "recovered",
      triggerLabel: "recovered",
      sealed: true,
      messageCount: 3,
      topicCounts: { "/a": 2, "/b": 1 },
    });
    // The recovered bytes are the mirror's, untouched.
    expect(Array.from(backing.clips.values())[0]?.bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
    // The mirror is consumed, so the next mount does not promote it again.
    expect(backing.mirrors.size).toBe(0);
    expect(out.last("clips")?.clips).toHaveLength(1);
  });

  it("promotes nothing from an empty mirror but still clears it", async () => {
    const backing = createFakeBacking();
    backing.mirrors.set("dead-worker", {
      meta: makeMirrorMeta({ messageCount: 0, topicCounts: {} }),
      bytes: new Uint8Array(),
    });

    const { engine } = harness({ backing, storeOptions: { instanceId: "live-worker" } });
    engine.start();
    await engine.whenIdle();

    expect(backing.clips.size).toBe(0);
    expect(backing.mirrors.size).toBe(0);
  });

  it("leaves a still-heartbeating sibling's mirror alone", async () => {
    // The case that matters: a second DIY DVR panel mounts while the first is running. The
    // first panel's mirror is *deletable* almost all the time — OPFS only locks it for the
    // instant of a write — so liveness has to come from the heartbeat. Taking it would destroy
    // a running panel's crash backstop, and lose its buffer if it were then torn down.
    const backing = createFakeBacking();
    const clock = createFakeClock();
    backing.mirrors.set("live-sibling", {
      meta: makeMirrorMeta({ messageCount: 4, updatedAt: clock.now() - 1000 }),
      bytes: new Uint8Array([1, 2]),
    });

    const { engine, out } = harness({
      backing,
      clock,
      mirrorIntervalMs: 5000,
      storeOptions: { instanceId: "this-worker" },
    });
    engine.start();
    await engine.whenIdle();

    expect(backing.clips.size).toBe(0);
    expect(backing.mirrors.has("live-sibling")).toBe(true);
    // A sibling being alive is normal, not something to alarm the user about.
    expect(out.all("error")).toHaveLength(0);
    expect(out.last("clips")?.cache.available).toBe(true);
  });

  it("promotes a mirror once its heartbeat has gone stale", async () => {
    const backing = createFakeBacking();
    const clock = createFakeClock();
    backing.mirrors.set("dead-worker", {
      meta: makeMirrorMeta({ messageCount: 4, updatedAt: clock.now() - 60_000 }),
      bytes: new Uint8Array([1, 2]),
    });

    const { engine } = harness({
      backing,
      clock,
      mirrorIntervalMs: 5000,
      storeOptions: { instanceId: "this-worker" },
    });
    engine.start();
    await engine.whenIdle();

    expect(storedClips(backing)[0]?.trigger).toBe("recovered");
    expect(backing.mirrors.size).toBe(0);
  });

  it("waits out the staleness threshold rather than promoting the moment it is quiet", async () => {
    // Just-missed-a-beat is not the same as gone, so a mirror one interval old is left alone.
    const backing = createFakeBacking();
    const clock = createFakeClock();
    backing.mirrors.set("maybe-alive", {
      meta: makeMirrorMeta({ messageCount: 4, updatedAt: clock.now() - 6000 }),
      bytes: new Uint8Array([1, 2]),
    });

    const { engine } = harness({
      backing,
      clock,
      mirrorIntervalMs: 5000,
      storeOptions: { instanceId: "this-worker" },
    });
    engine.start();
    await engine.whenIdle();
    expect(backing.clips.size).toBe(0);

    // Past three intervals with no refresh, it is fair game.
    clock.advance(10_000);
    const second = harness({
      backing,
      clock,
      mirrorIntervalMs: 5000,
      storeOptions: { instanceId: "another-worker" },
    });
    second.engine.start();
    await second.engine.whenIdle();
    expect(storedClips(backing)[0]?.trigger).toBe("recovered");
  });

  it("keeps a live mirror fresh by writing a heartbeat on every mirror", async () => {
    const backing = createFakeBacking();
    const clock = createFakeClock();
    const { engine } = harness({ backing, clock, frame: sizedFrame(64), mirrorIntervalMs: 5000 });
    engine.start();
    engine.configure(config());
    engine.addMessage(makeMsg("/a", 100));
    clock.advance(5000);
    engine.tick();
    await engine.whenIdle();

    const first = backing.mirrors.get("instance-a")?.meta.updatedAt;
    expect(first).toBe(clock.now());

    engine.addMessage(makeMsg("/a", 101));
    clock.advance(5000);
    engine.tick();
    await engine.whenIdle();
    expect(backing.mirrors.get("instance-a")?.meta.updatedAt).toBe(clock.now());
    expect(backing.mirrors.get("instance-a")?.meta.updatedAt).toBeGreaterThan(first ?? 0);
  });

  it("comes back for a mirror that goes stale after the mount", async () => {
    // On a reconnect the previous worker's mirror is still fresh, so start() correctly leaves
    // it be. Without a later look the window it holds would wait for some unrelated future
    // mount; instead recovery lands once the staleness threshold has passed.
    const backing = createFakeBacking();
    const clock = createFakeClock();
    backing.mirrors.set("just-terminated", {
      meta: makeMirrorMeta({ messageCount: 3, updatedAt: clock.now() - 500 }),
      bytes: new Uint8Array([1, 2, 3]),
    });

    const { engine, out } = harness({
      backing,
      clock,
      mirrorIntervalMs: 5000,
      storeOptions: { instanceId: "replacement" },
    });
    engine.start();
    engine.configure(config());
    await engine.whenIdle();

    // Too soon: as far as this worker knows, that mirror's owner may still be alive.
    expect(backing.clips.size).toBe(0);

    clock.advance(20_000);
    engine.tick();
    await engine.whenIdle();

    const clips = storedClips(backing);
    expect(clips).toHaveLength(1);
    expect(clips[0]?.trigger).toBe("recovered");
    expect(backing.mirrors.size).toBe(0);
    // The panel is told, rather than finding out on its next mutation.
    expect(out.last("clips")?.clips.map((clip) => clip.trigger)).toEqual(["recovered"]);
  });

  it("does not read a live sibling's payload at all", async () => {
    // Reading a mirror can mean reading a gigabyte, so a mirror that is not promotable must be
    // judged from its heartbeat alone — never by fetching its bytes to find out.
    const backing = createFakeBacking();
    const clock = createFakeClock();
    const refreshSibling = () => {
      backing.mirrors.set("live-sibling", {
        meta: makeMirrorMeta({ messageCount: 3, updatedAt: clock.now() }),
        bytes: new Uint8Array([1, 2, 3]),
      });
    };
    refreshSibling();

    const reads: string[] = [];
    const { engine } = harness({
      backing,
      clock,
      mirrorIntervalMs: 5000,
      storeOptions: { instanceId: "watcher", onReadMirror: (id) => reads.push(id) },
    });
    engine.start();
    engine.configure(config());
    await engine.whenIdle();

    // The sibling keeps writing, as a running worker does, so every scan sees it as fresh.
    for (let i = 0; i < 4; i++) {
      clock.advance(5000);
      refreshSibling();
      engine.tick();
      await engine.whenIdle();
    }

    expect(reads).toEqual([]);
    expect(backing.clips.size).toBe(0);
    expect(backing.mirrors.has("live-sibling")).toBe(true);
  });

  it("does not double-promote when two workers restart at the same moment", async () => {
    // Both see the same stale orphan. Claiming is removing the sidecar, so only the worker
    // whose delete actually removed it may promote; the loser must not write a second copy.
    const backing = createFakeBacking();
    const clock = createFakeClock();
    backing.mirrors.set("dead-worker", {
      meta: makeMirrorMeta({ messageCount: 4, updatedAt: 0 }),
      bytes: new Uint8Array([1, 2]),
    });

    const first = harness({
      backing,
      clock,
      mirrorIntervalMs: 5000,
      storeOptions: { instanceId: "worker-one" },
    });
    // Deterministic interleave: the second worker has already listed the orphan when the first
    // one runs its whole rehydrate and claims it.
    const second = harness({
      backing,
      clock,
      mirrorIntervalMs: 5000,
      storeOptions: {
        instanceId: "worker-two",
        beforeListOrphanMirrors: async () => {
          first.engine.start();
          await first.engine.whenIdle();
        },
      },
    });

    second.engine.start();
    await second.engine.whenIdle();

    const recovered = storedClips(backing).filter((clip) => clip.trigger === "recovered");
    expect(recovered).toHaveLength(1);
    expect(backing.mirrors.size).toBe(0);
  });

  it("leaves its own live mirror alone", async () => {
    const backing = createFakeBacking();
    backing.mirrors.set("live-worker", {
      meta: makeMirrorMeta({ messageCount: 5 }),
      bytes: new Uint8Array([9]),
    });

    const { engine } = harness({ backing, storeOptions: { instanceId: "live-worker" } });
    engine.start();
    await engine.whenIdle();

    expect(backing.clips.size).toBe(0);
    expect(backing.mirrors.has("live-worker")).toBe(true);
  });
});

describe("mirror throttle", () => {
  it("writes an un-sealed mirror no more than once per interval", async () => {
    const { engine, clock, backing } = harness({
      frame: sizedFrame(64),
      mirrorIntervalMs: 5000,
    });
    engine.start();
    engine.configure(config());
    engine.addMessage(makeMsg("/a", 100));

    // Too soon after construction.
    engine.tick();
    await engine.whenIdle();
    expect(backing.mirrors.size).toBe(0);

    clock.advance(5000);
    engine.tick();
    await engine.whenIdle();
    expect(backing.mirrors.size).toBe(1);
    const mirror = backing.mirrors.get("instance-a");
    expect(mirror?.meta.sealed).toBe(false);
    expect(mirror?.meta.messageCount).toBe(1);
    // A mirror is never a cached clip, so it cannot be evicted as one.
    expect(backing.clips.size).toBe(0);

    // Nothing new arrived, so there is nothing to re-mirror.
    clock.advance(60_000);
    engine.tick();
    await engine.whenIdle();
    expect(mirror).toBe(backing.mirrors.get("instance-a"));

    engine.addMessage(makeMsg("/a", 101));
    clock.advance(5000);
    engine.tick();
    await engine.whenIdle();
    expect(backing.mirrors.get("instance-a")?.meta.messageCount).toBe(2);
  });

  it("never starts a second mirror build while one is in flight", async () => {
    const blocking = blockingFrame();
    const { engine, clock } = harness({ frame: blocking.frame, mirrorIntervalMs: 5000 });
    engine.start();
    engine.configure(config());
    await engine.whenIdle();
    engine.addMessage(makeMsg("/a", 100));

    clock.advance(5000);
    engine.tick();
    await flushMicrotasks();
    expect(blocking.calls()).toBe(1);

    // The first build never settles; the throttle must not stack another one on top.
    engine.addMessage(makeMsg("/a", 101));
    clock.advance(60_000);
    engine.tick();
    engine.tick();
    await flushMicrotasks();
    expect(blocking.calls()).toBe(1);
  });
});

describe("cache eviction", () => {
  it("drops whole oldest clips once the cap is exceeded", async () => {
    const backing = createFakeBacking();
    backing.mirrors.set("instance-a", {
      meta: makeMirrorMeta(),
      bytes: new Uint8Array([7, 7]),
    });
    const { engine, clock } = harness({ backing, frame: sizedFrame(100) });
    engine.start();
    engine.configure(config({ maxCacheBytes: 250 }));
    engine.addMessage(makeMsg("/a", 100));
    await engine.whenIdle();
    const bufferedBefore = engine.stats().bufferedMsgs;

    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      engine.createClip("manual-clip");
      await engine.whenIdle();
      const newest = storedClips(backing)[storedClips(backing).length - 1];
      if (newest != undefined) {
        ids.push(newest.id);
      }
      clock.advance(1000);
    }

    // 4 clips x 100 bytes against a 250-byte cap leaves the two newest.
    const remaining = storedClips(backing);
    expect(remaining).toHaveLength(2);
    expect(remaining.map((clip) => clip.id)).toEqual(ids.slice(2));
    expect(remaining.reduce((total, clip) => total + clip.byteSize, 0)).toBeLessThanOrEqual(250);
    // Neither the live ring nor the mirror is ever evicted.
    expect(engine.stats().bufferedMsgs).toBe(bufferedBefore);
    expect(backing.mirrors.get("instance-a")?.bytes).toEqual(new Uint8Array([7, 7]));
  });

  it("keeps the newest clip even when it alone exceeds the cap", async () => {
    const { engine, backing, clock } = harness({ frame: sizedFrame(100) });
    engine.start();
    engine.configure(config({ maxCacheBytes: 50 }));
    engine.addMessage(makeMsg("/a", 100));

    engine.createClip("manual-clip");
    await engine.whenIdle();
    expect(backing.clips.size).toBe(1);
    const first = storedClips(backing)[0]?.id;

    clock.advance(1000);
    engine.createClip("manual-clip");
    await engine.whenIdle();
    const remaining = storedClips(backing);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).not.toBe(first);
  });

  it("applies a newly-lowered cap without waiting for the next clip", async () => {
    const { engine, backing, clock } = harness({ frame: sizedFrame(100) });
    engine.start();
    engine.configure(config());
    engine.addMessage(makeMsg("/a", 100));
    for (let i = 0; i < 3; i++) {
      engine.createClip("manual-clip");
      await engine.whenIdle();
      clock.advance(1000);
    }
    expect(backing.clips.size).toBe(3);

    engine.configure(config({ maxCacheBytes: 150 }));
    await engine.whenIdle();
    expect(backing.clips.size).toBe(1);
  });
});

describe("clip management", () => {
  it("deletes one clip and re-broadcasts the list", async () => {
    const { engine, backing, clock, out } = harness();
    engine.start();
    engine.configure(config());
    engine.addMessage(makeMsg("/a", 100));
    engine.createClip("manual-clip");
    await engine.whenIdle();
    clock.advance(1000);
    engine.createClip("closing");
    await engine.whenIdle();
    const [first, second] = storedClips(backing);

    engine.deleteClip(first?.id ?? "");
    await engine.whenIdle();

    expect(backing.clips.size).toBe(1);
    expect(out.last("clips")?.clips.map((clip) => clip.id)).toEqual([second?.id]);
  });

  it("clears every clip", async () => {
    const { engine, backing, out } = harness();
    engine.start();
    engine.configure(config());
    engine.addMessage(makeMsg("/a", 100));
    engine.createClip("manual-clip");
    engine.createClip("closing");
    await engine.whenIdle();
    expect(backing.clips.size).toBe(2);

    engine.clearClips();
    await engine.whenIdle();

    expect(backing.clips.size).toBe(0);
    expect(out.last("clips")?.clips).toEqual([]);
  });

  it("hands back the bytes of a cached clip", async () => {
    const { engine, backing, out } = harness({ frame: sizedFrame(256) });
    engine.start();
    engine.configure(config());
    engine.addMessage(makeMsg("/a", 100));
    engine.createClip("manual-clip");
    await engine.whenIdle();
    const id = storedClips(backing)[0]?.id ?? "";

    engine.requestClipBytes(id);
    await engine.whenIdle();

    const response = out.last("clipBytes");
    expect(response?.id).toBe(id);
    expect(response?.buffer.byteLength).toBe(256);
    expect(response?.meta.trigger).toBe("manual-clip");
  });

  it("reports a clip that is no longer cached", async () => {
    const { engine, out } = harness();
    engine.start();
    await engine.whenIdle();
    out.clear();

    engine.requestClipBytes("clip-does-not-exist");
    await engine.whenIdle();

    expect(out.last("error")?.message).toContain("no longer cached");
    expect(out.last("clips")?.clips).toEqual([]);
  });
});

describe("graceful degradation", () => {
  it("keeps capturing when the durable store is unavailable", async () => {
    const { engine, backing, out } = harness({ storeOptions: { failInit: true } });
    engine.start();
    await engine.whenIdle();

    expect(out.all("error")).toHaveLength(1);
    expect(out.last("clips")).toMatchObject({
      clips: [],
      cache: { available: false, mode: "unavailable" },
    });

    // Live capture is unaffected.
    engine.configure(config({ gapMs: 10_000 }));
    engine.addMessage(makeMsg("/a", 100));
    expect(engine.stats().bufferedMsgs).toBe(1);

    // A trigger explains itself once instead of failing silently or throwing.
    engine.createClip("manual-clip");
    engine.createClip("closing");
    await engine.whenIdle();
    expect(backing.clips.size).toBe(0);
    expect(out.all("error")).toHaveLength(2);
  });

  it("reports a failed clip write and keeps the buffer intact", async () => {
    const storeOptions: FakeStoreOptions = { failWrites: true };
    const { engine, backing, out } = harness({ storeOptions });
    engine.start();
    engine.configure(config());
    engine.addMessage(makeMsg("/a", 100));

    engine.createClip("manual-clip");
    await engine.whenIdle();

    expect(out.last("error")?.message).toContain("quota");
    expect(backing.clips.size).toBe(0);
    expect(engine.bufferedRecords()).toHaveLength(1);

    // The engine is not latched off: a later write still lands.
    storeOptions.failWrites = false;
    engine.createClip("manual-clip");
    await engine.whenIdle();
    expect(backing.clips.size).toBe(1);
  });
});

describe("capture is deterministic (a clip cannot inflate a fixed input)", () => {
  /** Framer that records the exact snapshots it is handed, and frames them for real. */
  function recordingFramer(): { frame: FrameFn; snapshots: Array<readonly DvrRecord[]> } {
    const snapshots: Array<readonly DvrRecord[]> = [];
    return {
      snapshots,
      frame: async (records, schemas) => {
        snapshots.push(records);
        return await buildMcap(records, schemas);
      },
    };
  }

  it("frames byte-identical clips from the same records", async () => {
    // The scare this guards against: a clip that grew while message count and duration stayed
    // flat. If the same input ever produces different output, this fails loudly.
    const backing = createFakeBacking();
    const framer = recordingFramer();
    const { engine } = harness({ backing, frame: framer.frame });
    engine.start();
    engine.configure(config());
    for (let sec = 100; sec < 110; sec++) {
      engine.addMessage(makeMsg("/a", sec, { message: { value: sec, text: "x".repeat(sec) } }));
      engine.addMessage(makeMsg("/b", sec));
    }

    engine.createClip("manual-clip");
    await engine.whenIdle();
    engine.createClip("manual-clip");
    await engine.whenIdle();

    const clips = Array.from(backing.clips.values());
    expect(clips).toHaveLength(2);
    expect(clips[0]?.bytes).toEqual(clips[1]?.bytes);
    expect(clips[0]?.meta.byteSize).toBe(clips[1]?.meta.byteSize);
  });

  it("encodes each message once and reuses that buffer for every clip", async () => {
    // Re-encoding per clip would be where silent growth could creep in, so assert the very
    // same buffer object is handed to both frames.
    const framer = recordingFramer();
    const { engine } = harness({ frame: framer.frame });
    engine.start();
    engine.configure(config());
    engine.addMessage(makeMsg("/a", 100));
    engine.addMessage(makeMsg("/a", 101));

    engine.createClip("manual-clip");
    await engine.whenIdle();
    engine.createClip("backgrounded");
    await engine.whenIdle();

    expect(framer.snapshots).toHaveLength(2);
    const [first, second] = framer.snapshots;
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    for (let i = 0; i < 2; i++) {
      expect(second?.[i]?.data).toBe(first?.[i]?.data);
    }
  });

  it("grows only in step with the source: a swelling payload inflates clips, a fixed one does not", async () => {
    // This is the documented explanation for the original report — a user-script topic that
    // republishes an ever-longer trail. Capture is faithful; the topic is the one growing.
    const backing = createFakeBacking();
    const { engine } = harness({ backing, frame: buildMcap });
    engine.start();
    engine.configure(config());

    const measure = async (trigger: "manual-clip" | "backgrounded") => {
      engine.createClip(trigger);
      await engine.whenIdle();
      const clips = storedClips(backing);
      return clips[clips.length - 1];
    };

    // Same message count on both topics; only /grows has an expanding payload.
    for (let i = 0; i < 20; i++) {
      engine.addMessage(makeMsg("/fixed", 100 + i, { message: { trail: [1, 2, 3] } }));
      engine.addMessage(
        makeMsg("/grows", 100 + i, {
          message: { trail: Array.from({ length: (i + 1) * 50 }, () => 1) },
        }),
      );
    }
    const meta = await measure("manual-clip");

    expect(meta?.topicCounts).toEqual({ "/fixed": 20, "/grows": 20 });
    const fixedBytes = meta?.topicBytes?.["/fixed"] ?? 0;
    const growsBytes = meta?.topicBytes?.["/grows"] ?? 0;
    expect(growsBytes).toBeGreaterThan(fixedBytes * 20);

    // Duration and message count are flat across a second window, yet the clip is bigger,
    // purely because the newer messages carry more data.
    for (let i = 20; i < 40; i++) {
      engine.addMessage(makeMsg("/fixed", 100 + i, { message: { trail: [1, 2, 3] } }));
      engine.addMessage(
        makeMsg("/grows", 100 + i, {
          message: { trail: Array.from({ length: (i + 1) * 50 }, () => 1) },
        }),
      );
    }
    const later = await measure("backgrounded");
    expect(later?.topicBytes?.["/fixed"]).toBeGreaterThan(fixedBytes);
    expect(later?.topicBytes?.["/grows"]).toBeGreaterThan(growsBytes * 2);
  });
});

describe("per-topic byte metadata", () => {
  it("sums each topic's encoded payload", async () => {
    const backing = createFakeBacking();
    const { engine } = harness({ backing });
    engine.start();
    engine.configure(config());
    engine.addMessage(makeMsg("/a", 100, { message: { v: "aaaa" } }));
    engine.addMessage(makeMsg("/a", 101, { message: { v: "bb" } }));
    engine.addMessage(makeMsg("/b", 102, { message: { v: "cccccccc" } }));

    // The engine's own view of the buffer is the reference for what the metadata should say.
    const expected: Record<string, number> = {};
    for (const record of engine.bufferedRecords()) {
      expected[record.topic] = (expected[record.topic] ?? 0) + record.data.byteLength;
    }

    engine.createClip("manual-clip");
    await engine.whenIdle();

    const meta = storedClips(backing)[0];
    expect(meta?.topicBytes).toEqual(expected);
    expect(Object.values(meta?.topicBytes ?? {}).reduce((a, b) => a + b, 0)).toBe(
      engine.stats().byteTotal,
    );
  });
});

describe("bounded mirror cost", () => {
  it("waits in proportion to what the last mirror cost", async () => {
    // On a fixed timer, mirroring a multi-GB ring would consume most of the wall clock as the
    // ring grows. The gap scales with the measured cost instead, so the share stays bounded.
    const clock = createFakeClock();
    const backing = createFakeBacking();
    let frames = 0;
    const { engine } = harness({
      backing,
      clock,
      mirrorIntervalMs: 5000,
      frame: async () => {
        frames++;
        clock.advance(2000); // this mirror took two seconds
        return new Uint8Array(64);
      },
    });
    engine.start();
    engine.configure(config());
    engine.addMessage(makeMsg("/a", 100));

    clock.advance(5000);
    engine.tick();
    await engine.whenIdle();
    expect(frames).toBe(1);

    // One interval later is no longer enough: 2 s of work earns a 18 s gap.
    engine.addMessage(makeMsg("/a", 101));
    clock.advance(5000);
    engine.tick();
    await engine.whenIdle();
    expect(frames).toBe(1);

    clock.advance(13_000);
    engine.tick();
    await engine.whenIdle();
    expect(frames).toBe(2);
  });

  it("still mirrors on the plain interval when the work is cheap", async () => {
    const clock = createFakeClock();
    let frames = 0;
    const { engine } = harness({
      clock,
      mirrorIntervalMs: 5000,
      frame: async () => {
        frames++;
        return new Uint8Array(64);
      },
    });
    engine.start();
    engine.configure(config());
    engine.addMessage(makeMsg("/a", 100));
    clock.advance(5000);
    engine.tick();
    await engine.whenIdle();
    engine.addMessage(makeMsg("/a", 101));
    clock.advance(5000);
    engine.tick();
    await engine.whenIdle();
    expect(frames).toBe(2);
  });
});

describe("writing into a full cache", () => {
  it("frees room before writing rather than after", async () => {
    // Evicting only after the write means a cache at its cap has to survive being over it —
    // and if the write fails for want of space, the eviction that would have freed some
    // never runs.
    const backing = createFakeBacking();
    const clock = createFakeClock();
    const { engine, out } = harness({
      backing,
      clock,
      frame: sizedFrame(100),
      storeOptions: { quotaBytes: 250 },
    });
    engine.start();
    engine.configure(config({ maxCacheBytes: 250 }));
    engine.addMessage(makeMsg("/a", 100));

    for (let i = 0; i < 4; i++) {
      engine.createClip("manual-clip");
      await engine.whenIdle();
      clock.advance(1000);
    }

    // Every write landed; nothing hit the quota.
    expect(out.all("error")).toHaveLength(0);
    const total = storedClips(backing).reduce((sum, clip) => sum + clip.byteSize, 0);
    expect(total).toBeLessThanOrEqual(250);
    expect(backing.clips.size).toBeGreaterThan(0);
  });
});

describe("durable store that never opens", () => {
  it("gives up after the timeout instead of stalling the panel", async () => {
    // A hung getDirectory() would otherwise leave the queue parked forever and the panel
    // showing "Reading the clip cache…" with no way out.
    const { engine, out } = harness({
      initTimeoutMs: 5,
      storeOptions: { hangInit: true },
    });
    engine.start();
    await engine.whenIdle();

    expect(out.last("error")?.message).toContain("Timed out");
    expect(out.last("clips")).toMatchObject({ clips: [], cache: { available: false } });
    // Live capture is untouched by a cache that never opened.
    engine.configure(config());
    engine.addMessage(makeMsg("/a", 100));
    expect(engine.stats().bufferedMsgs).toBe(1);
  });
});

describe("64-bit integer fields", () => {
  it("keeps a value that a double cannot hold exactly", () => {
    const { engine } = harness();
    engine.configure(config());
    const huge = 9_007_199_254_740_993n; // 2^53 + 1, not representable as a double
    engine.addMessage(makeMsg("/a", 100, { message: { small: 42n, huge } }));

    const encoded = new TextDecoder().decode(engine.bufferedRecords()[0]?.data);
    const parsed = JSON.parse(encoded) as { small: unknown; huge: unknown };
    // Within the safe range a number is what an integer field's consumers expect.
    expect(parsed.small).toBe(42);
    // Beyond it, the exact digits are kept rather than a silently different number.
    expect(parsed.huge).toBe("9007199254740993");
    expect(encoded).not.toContain("9007199254740992");
  });
});

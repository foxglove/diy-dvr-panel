// Unit tests for the capture core. No DOM, no Worker, no Foxglove app: the engine takes
// an injected store, clock, output sink, and MCAP framer, so everything below is plain
// TypeScript running in Node.

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
  });
  return { engine, clock, backing, store, out };
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

  it("leaves a mirror it cannot claim to its live owner", async () => {
    // Two panels share the origin's cache. A mirror that cannot be deleted is still held
    // by a running worker, so promoting it would duplicate a live panel's backstop.
    const backing = createFakeBacking();
    backing.mirrors.set("live-sibling", {
      meta: makeMirrorMeta({ messageCount: 4 }),
      bytes: new Uint8Array([1, 2]),
    });

    const { engine, out } = harness({
      backing,
      storeOptions: {
        instanceId: "this-worker",
        lockedMirrors: new Set(["live-sibling"]),
      },
    });
    engine.start();
    await engine.whenIdle();

    expect(backing.clips.size).toBe(0);
    expect(backing.mirrors.has("live-sibling")).toBe(true);
    // Contention is expected here, not something to alarm the user about.
    expect(out.all("error")).toHaveLength(0);
    expect(out.last("clips")?.cache.available).toBe(true);
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

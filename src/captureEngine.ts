// The capture core: the rolling ring buffer, the durable clip cache, and everything
// that decides when to snapshot. Extracted out of `mcap.worker.ts` so it holds no
// `postMessage`, `self`, DOM, or timer references and can be unit-tested as plain
// TypeScript in Node — the same reason `settings.ts` is kept pure.
//
// Everything the engine cannot do by itself is injected: the durable store
// (`ClipStore`), the clock (`now`), the output sink (`emit`), and optionally the MCAP
// framer (`frame`, defaults to `buildMcap`). `mcap.worker.ts` wires those to the real
// OPFS store, `Date.now`, `postMessage`, and a 1 Hz `tick()`.
//
// Three concerns, deliberately kept separate:
//
//  1. The live ring — an in-memory FIFO bounded by the configured lookback. Unchanged
//     behavior from before: it evicts the oldest record, or rotates the whole window
//     when auto-save is on. Additionally mirrored to the store on a throttle as a
//     crash-recovery backstop; the mirror never resets the ring.
//  2. Clips — non-destructive snapshots of the ring written to the store when a trigger
//     fires (a WS gap, the tab being hidden or closed, a manual request, or the
//     promotion of a mirror left behind by a dead worker). Snapshotting never clears
//     the ring.
//  3. Cache eviction — after a clip is written, whole oldest clips are dropped until the
//     total is back under the byte cap. The live ring and the mirror are never evicted.
//
// All store access runs through one serialized queue (`#enqueue`), so there is a single
// writer, no overlapping builds, and deterministic ordering for the tests.

import { buildMcap, DvrRecord, DvrSchema } from "./buildMcap";
import { ClipMeta, ClipTrigger, PanelTrigger, planEviction } from "./clipTypes";
import { JsonSchema, mergeJsonSchema, rootSchema } from "./inferSchema";
import { ClipStore, ClipStoreMode } from "./opfsStore";
import { resolveSchema } from "./schemaRegistry";

/** How often the live ring is mirrored to durable storage, unless overridden. */
export const DEFAULT_MIRROR_INTERVAL_MS = 5000;

export type Time = { sec: number; nsec: number };

/** One decoded message forwarded from the panel's `onRender`. */
export type EngineInboundMsg = {
  topic: string;
  schemaName?: string;
  receiveTime?: Time;
  publishTime?: Time;
  message: unknown;
};

export type EngineConfig = {
  budgetMode: "time" | "bytes";
  budgetNanos?: bigint;
  budgetBytes?: number;
  autoSave: boolean;
  enabledTopics: string[];
  /** Total cap on cached clip bytes. Undefined leaves the cache unbounded. */
  maxCacheBytes?: number;
  /** Silence longer than this fires a `gap` clip. Zero or undefined disables it. */
  gapMs?: number;
};

export type EngineStat = {
  type: "stat";
  messageCount: number;
  channels: number;
  bufferedMsgs: number;
  byteTotal: number;
  oldestNanos: string;
  newestNanos: string;
  rotations: number;
};

/** Whether the durable cache is usable, and which OPFS path is live. */
export type CacheStatus = { available: boolean; mode: ClipStoreMode };

export type EngineOutput =
  | EngineStat
  | {
      type: "saved";
      buffer: ArrayBuffer;
      messageCount: number;
      channels: number;
      rotation: boolean;
    }
  | { type: "clips"; clips: ClipMeta[]; cache: CacheStatus }
  | { type: "clipBytes"; id: string; meta: ClipMeta; buffer: ArrayBuffer }
  | { type: "error"; message: string };

export type FrameFn = (
  records: readonly DvrRecord[],
  schemaByTopic: ReadonlyMap<string, DvrSchema>,
) => Promise<Uint8Array>;

export type CaptureEngineDeps = {
  store: ClipStore;
  /** Wall-clock milliseconds. Injected so tests can drive time without real timers. */
  now: () => number;
  emit: (message: EngineOutput, transfer?: Transferable[]) => void;
  /** MCAP framer. Defaults to `buildMcap`; tests inject a stub for exact byte sizes. */
  frame?: FrameFn;
  mirrorIntervalMs?: number;
  /** Retry backoff. Injected so tests do not wait on real timers. */
  delay?: (ms: number) => Promise<void>;
  /** How long `store.init()` may take before the cache is declared unusable. */
  initTimeoutMs?: number;
};

/** Per topic: a real schema resolved from the registry, or an inferred, merged one. */
type TopicSchema = { name: string; schema: JsonSchema; fromRegistry: boolean };

const TRIGGER_LABELS: Record<Exclude<ClipTrigger, "gap">, string> = {
  backgrounded: "backgrounded",
  closing: "closing",
  "manual-clip": "manual",
  rotation: "auto-save",
  recovered: "recovered",
};

/**
 * How many mirror intervals a mirror may go unrefreshed before another worker treats it as
 * abandoned. Recovery is delayed by this much, which is the price of never stealing a live
 * panel's backstop.
 */
const MIRROR_STALE_INTERVALS = 3;

/**
 * Ceiling on how much wall time mirroring may consume, as a multiple of its own measured cost.
 * Framing and writing a multi-GB ring takes seconds, and on a fixed timer that work would grow
 * without bound as the ring does; waiting this many times the last mirror's duration keeps it
 * to roughly 1/(1 + N) of the time whatever the ring's size.
 */
const MIRROR_COST_MULTIPLIER = 9;

/** How long to wait for the durable store to open before giving up on it. */
const DEFAULT_INIT_TIMEOUT_MS = 10_000;

/**
 * Backoff before retrying a failed rehydrate step. The usual cause is OPFS exclusive-lock
 * contention with a worker that is still shutting down, which clears in milliseconds.
 */
const REHYDRATE_RETRY_DELAYS_MS = [50, 250];

export class CaptureEngine {
  readonly #store: ClipStore;
  readonly #now: () => number;
  readonly #emit: (message: EngineOutput, transfer?: Transferable[]) => void;
  readonly #frame: FrameFn;
  readonly #mirrorIntervalMs: number;
  readonly #initTimeoutMs: number;
  readonly #delay: (ms: number) => Promise<void>;
  readonly #encoder = new TextEncoder();

  // --- live ring ---
  /** Kept sorted ascending by `logTime`, so the ends are always the window's min/max. */
  readonly #records: DvrRecord[] = [];
  #byteTotal = 0;
  readonly #schemaByTopic = new Map<string, TopicSchema>();
  #messageCount = 0;
  #rotations = 0;
  /** Message count at the last emitted stat, so `tick()` only reports real changes. */
  #lastStatMessageCount = -1;

  // --- config (unbounded / no auto-save until the first `configure`) ---
  #budgetMode: "time" | "bytes" = "time";
  #budgetNanos: bigint | undefined = undefined;
  #budgetBytes: number | undefined = undefined;
  #autoSave = false;
  #enabledSet: Set<string> | undefined = undefined;
  #maxCacheBytes: number | undefined = undefined;
  #gapMs: number | undefined = undefined;

  // --- clip cache ---
  #clips: ClipMeta[] = [];
  #cacheAvailable = true;
  #warnedUnavailable = false;
  #seq = 0;

  // --- gap detection ---
  #lastMessageAt: number | undefined = undefined;
  #gapArmed = false;

  // --- mirror throttle (seeded to construction time so the first mirror waits one
  // interval instead of firing on the very first tick) ---
  #lastMirrorAt: number;
  /** When orphaned mirrors were last looked for (see `#maybeScanForOrphans`). */
  #lastOrphanScanAt: number;
  /** Duration of the last mirror build+write, which sets the floor on the next gap. */
  #lastMirrorCostMs = 0;
  #mirrorInFlight = false;
  #mirroredMessageCount = -1;

  /** Serializes every store operation: one writer, no overlapping builds. */
  #queue: Promise<void> = Promise.resolve();

  public constructor(deps: CaptureEngineDeps) {
    this.#store = deps.store;
    this.#now = deps.now;
    this.#emit = deps.emit;
    this.#frame = deps.frame ?? buildMcap;
    this.#mirrorIntervalMs = deps.mirrorIntervalMs ?? DEFAULT_MIRROR_INTERVAL_MS;
    this.#initTimeoutMs = deps.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    this.#delay =
      deps.delay ??
      (async (ms: number) => {
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
      });
    this.#lastMirrorAt = deps.now();
    this.#lastOrphanScanAt = deps.now();
  }

  // --- lifecycle ------------------------------------------------------------------

  /**
   * Open the store, rehydrate the clip list, and promote any mirror a previous worker
   * left behind. This is what makes clips survive an `initPanel` teardown: they live in
   * OPFS, and the fresh worker reads them back.
   */
  public start(): void {
    this.#enqueue(async () => {
      try {
        // A hung getDirectory() would otherwise stall this queue for good, leaving the panel
        // on "Reading the clip cache…" with no way out.
        await withTimeout(this.#store.init(), this.#initTimeoutMs, "open the clip cache");
      } catch (err) {
        // No durable cache here (an old build, a non-secure context, a denied quota).
        // Live capture is unaffected, so report it and carry on.
        this.#cacheAvailable = false;
        this.#emitError(err);
        this.#broadcastClips();
        return;
      }
      // Every step below is individually guarded, and the broadcast happens either way.
      // A throw part-way through used to skip it entirely, leaving the panel showing its
      // empty initial list until the next mutation — cached clips looked lost.
      const listed = await this.#attempt(
        "read the cached clips",
        async () => await this.#store.listClips(),
      );
      if (listed != undefined) {
        this.#clips = listed;
        this.#seq = this.#clips.length;
      }
      await this.#attempt("recover the previous session", async () => {
        await this.#promoteOrphanMirrors();
      });
      this.#lastOrphanScanAt = this.#now();
      await this.#attempt("apply the clip cache limit", async () => {
        await this.#evictToCap();
      });
      this.#broadcastClips();
    });
  }

  /**
   * Run one rehydrate step, retrying briefly before giving up, and never throwing. The
   * failure this defends against is transient: OPFS grants exclusive file access, so a
   * worker that is still shutting down can hold a mirror while the new one starts reading.
   * On permanent failure the caller keeps whatever it already has.
   */
  async #attempt<T>(what: string, operation: () => Promise<T>): Promise<T | undefined> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await operation();
      } catch (err) {
        const backoffMs = REHYDRATE_RETRY_DELAYS_MS[attempt];
        if (backoffMs == undefined) {
          const reason = err instanceof Error ? err.message : String(err);
          this.#emit({ type: "error", message: `Could not ${what}: ${reason}` });
          return undefined;
        }
        await this.#delay(backoffMs);
      }
    }
  }

  /**
   * Drain the store queue. Used by the tests, and by anything that needs to know the
   * durable side has settled. Loops because a queued operation can enqueue more work.
   */
  public async whenIdle(): Promise<void> {
    let pending = this.#queue;
    await pending;
    while (pending !== this.#queue) {
      pending = this.#queue;
      await pending;
    }
  }

  // --- inbound ---------------------------------------------------------------------

  public configure(config: EngineConfig): void {
    this.#budgetMode = config.budgetMode;
    this.#budgetNanos = config.budgetNanos;
    this.#budgetBytes = config.budgetBytes;
    this.#autoSave = config.autoSave;
    this.#enabledSet = new Set(config.enabledTopics);
    this.#maxCacheBytes = config.maxCacheBytes;
    this.#gapMs = config.gapMs;
    // A newly-tightened budget may already be exceeded by the current buffer.
    this.#enforceBudget();
    this.#postStat();
    // A newly-lowered cache cap should take effect without waiting for the next clip.
    if (this.#cacheAvailable) {
      this.#enqueueCacheOp(async () => {
        const evicted = await this.#evictToCap();
        if (evicted) {
          this.#broadcastClips();
        }
      });
    }
  }

  public addMessage(msg: EngineInboundMsg): void {
    // Defensively drop messages for a topic that was just disabled but is still in
    // flight (the panel already only subscribes to enabled topics).
    const enabled = this.#enabledSet;
    if (enabled != undefined && enabled.size > 0 && !enabled.has(msg.topic)) {
      return;
    }

    // Any traffic re-arms the gap trigger.
    this.#lastMessageAt = this.#now();
    this.#gapArmed = true;

    const name =
      msg.schemaName != undefined && msg.schemaName.length > 0 ? msg.schemaName : msg.topic;
    const existing = this.#schemaByTopic.get(msg.topic);
    if (existing == undefined) {
      // First message on this topic: prefer a real schema from the registry.
      const registrySchema = name.length > 0 ? resolveSchema(name) : undefined;
      this.#schemaByTopic.set(
        msg.topic,
        registrySchema
          ? { name, schema: registrySchema, fromRegistry: true }
          : { name, schema: rootSchema(msg.message), fromRegistry: false },
      );
    } else if (!existing.fromRegistry) {
      // Unknown schema: keep refining the inferred shape as more messages arrive.
      existing.schema = mergeJsonSchema(existing.schema, rootSchema(msg.message));
    }

    // Key the buffered/saved timeline off the message's published time (the source's own
    // clock) when present, falling back to receive/wall time. This keeps the ring and the
    // saved MCAP consistent even when arrival order differs from publish order.
    const logTime = toNanos(msg.publishTime ?? msg.receiveTime);
    const data = this.#encodeMessage(msg.message);
    this.#insertRecord({
      topic: msg.topic,
      logTime,
      publishTime: msg.publishTime != undefined ? toNanos(msg.publishTime) : logTime,
      data,
    });
    this.#byteTotal += data.byteLength;
    this.#messageCount++;

    this.#enforceBudget();

    if (this.#messageCount % 200 === 0) {
      this.#postStat();
    }
  }

  /**
   * Periodic work the engine cannot schedule itself: the wall-clock gap check and the
   * throttled mirror. The worker adapter calls this about once a second.
   *
   * Worker timers are throttled while a tab is in the background, so this can stall
   * exactly when a gap would fire — which is why the panel also posts an explicit
   * `backgrounded` trigger when the tab is hidden.
   */
  public tick(): void {
    this.#checkGap();
    this.#maybeMirror();
    this.#maybeScanForOrphans();
    // Message-count-triggered stats alone can lag badly on a slow feed, and the panel
    // pins a live buffer status, so also report on the tick whenever something changed.
    if (this.#messageCount !== this.#lastStatMessageCount) {
      this.#postStat();
    }
  }

  /** Non-destructive: frame the current window and hand the bytes to the panel. */
  public save(): void {
    const schemas = this.#snapshotSchemaMap();
    this.#frame(this.#records, schemas)
      .then((bytes) => {
        this.#emitBuffer(bytes, "manual");
      })
      .catch((err: unknown) => {
        this.#emitError(err);
      });
  }

  /** Clear the live ring only. Cached clips are durable and are left alone. */
  public reset(): void {
    this.#records.length = 0;
    this.#byteTotal = 0;
    this.#schemaByTopic.clear();
    this.#messageCount = 0;
    this.#rotations = 0;
    this.#mirroredMessageCount = -1;
    this.#lastMessageAt = undefined;
    this.#gapArmed = false;
    this.#postStat();
  }

  /** Snapshot the current ring into a durable clip. Never clears the ring. */
  public createClip(trigger: PanelTrigger): void {
    this.#requestClip(trigger, TRIGGER_LABELS[trigger]);
  }

  public deleteClip(id: string): void {
    if (!this.#requireCache()) {
      return;
    }
    this.#enqueueCacheOp(async () => {
      await this.#store.deleteClip(id);
      this.#clips = await this.#store.listClips();
      this.#broadcastClips();
    });
  }

  public clearClips(): void {
    if (!this.#requireCache()) {
      return;
    }
    this.#enqueueCacheOp(async () => {
      await this.#store.clearClips();
      this.#clips = await this.#store.listClips();
      this.#broadcastClips();
    });
  }

  /** Read a cached clip back out so the panel can write it to disk. */
  public requestClipBytes(id: string): void {
    if (!this.#requireCache()) {
      return;
    }
    this.#enqueueCacheOp(async () => {
      const meta = this.#clips.find((clip) => clip.id === id);
      const bytes = await this.#store.readClip(id);
      if (meta == undefined || bytes == undefined) {
        // Evicted or deleted between the broadcast and the click.
        this.#emit({ type: "error", message: `Clip ${id} is no longer cached` });
        this.#clips = await this.#store.listClips();
        this.#broadcastClips();
        return;
      }
      const buffer = toArrayBuffer(bytes);
      this.#emit({ type: "clipBytes", id, meta, buffer }, [buffer]);
    });
  }

  // --- read-only views (also used by the tests) ------------------------------------

  public stats(): EngineStat {
    const oldest = this.#records[0];
    const newest = this.#records[this.#records.length - 1];
    return {
      type: "stat",
      messageCount: this.#messageCount,
      channels: this.#schemaByTopic.size,
      bufferedMsgs: this.#records.length,
      byteTotal: this.#byteTotal,
      oldestNanos: (oldest?.logTime ?? 0n).toString(),
      newestNanos: (newest?.logTime ?? 0n).toString(),
      rotations: this.#rotations,
    };
  }

  /** The live ring, oldest first. A read-only view of the engine's own array. */
  public bufferedRecords(): readonly DvrRecord[] {
    return this.#records;
  }

  public cacheStatus(): CacheStatus {
    return { available: this.#cacheAvailable, mode: this.#store.mode() };
  }

  // --- clips -----------------------------------------------------------------------

  #requestClip(trigger: ClipTrigger, label: string): void {
    if (this.#records.length === 0) {
      return; // nothing worth writing
    }
    // Freeze the window synchronously, exactly like an auto-save rotation does, so a slow
    // build cannot capture a window that has moved on. The ring itself is untouched.
    this.#cacheSnapshot(this.#records.slice(), this.#snapshotSchemaMap(), trigger, label);
  }

  /**
   * Frame an already-frozen window and write it to the durable cache. Separate from
   * {@link CaptureEngine.#requestClip} because an auto-save rotation has to hand over a
   * snapshot it has *already* cleared from the live ring.
   */
  #cacheSnapshot(
    snapshot: readonly DvrRecord[],
    schemas: Map<string, DvrSchema>,
    trigger: ClipTrigger,
    label: string,
  ): void {
    if (!this.#requireCache() || snapshot.length === 0) {
      return;
    }
    this.#enqueueCacheOp(async () => {
      const bytes = await this.#frame(snapshot, schemas);
      const meta = this.#buildMeta(snapshot, bytes.byteLength, {
        trigger,
        triggerLabel: label,
        sealed: true,
      });
      // Make room before writing rather than after. Evicting afterwards means a cache already
      // at its cap has to survive being briefly over it — and if the write fails for want of
      // space, the eviction that would have freed some never runs.
      await this.#evictToCap(bytes.byteLength);
      await this.#store.writeClip(meta, bytes);
      this.#clips = await this.#store.listClips();
      await this.#evictToCap();
      this.#broadcastClips();
    });
  }

  /**
   * Promote every mirror left behind by another worker instance into a `recovered` clip.
   *
   * A crash and a silent reconnect teardown are mechanically indistinguishable — both
   * leave an un-sealed mirror — so both are promoted. That is the point of the feature:
   * it preserves the live buffer across the teardown this exists to defend against. The
   * promoted clip can be up to one mirror interval stale.
   */
  async #promoteOrphanMirrors(): Promise<boolean> {
    const orphans = await this.#store.listOrphanMirrors();
    // A mirror is only abandoned once it has stopped being refreshed. Deletability cannot
    // answer this: OPFS holds the exclusive lock only while a write is actually in flight, so
    // a live sibling's mirror is deletable in the gaps between its writes — and taking it
    // would destroy the crash backstop of a panel that is still running, then lose its buffer
    // if it were torn down before writing again.
    const staleBefore = this.#now() - this.#mirrorIntervalMs * MIRROR_STALE_INTERVALS;
    let promoted = 0;
    for (const orphan of orphans) {
      const heartbeat = orphan.meta.updatedAt ?? 0;
      if (heartbeat > staleBefore) {
        continue; // its owner is still writing
      }
      if (orphan.meta.messageCount < 1) {
        // Nothing to promote, but clear it so it is not reconsidered on every scan.
        await this.#claimMirror(orphan.instanceId);
        continue;
      }
      // Read before claiming, since claiming deletes the payload. The read is wasted only in
      // the rare case that another worker claims it first.
      const bytes = await this.#store.readMirror(orphan.instanceId);
      if (bytes == undefined) {
        continue;
      }
      // Claiming is removing the sidecar. Two workers restarting together both see the same
      // orphan, and only the one whose delete actually removed it may promote.
      if (!(await this.#claimMirror(orphan.instanceId))) {
        continue; // another worker got there first
      }
      const meta: ClipMeta = {
        ...orphan.meta,
        id: this.#nextClipId(),
        trigger: "recovered",
        triggerLabel: TRIGGER_LABELS.recovered,
        createdAt: this.#now(),
        sealed: true,
      };
      await this.#store.writeClip(meta, bytes);
      promoted++;
    }
    if (promoted > 0) {
      await this.#pruneRecovered();
      this.#clips = await this.#store.listClips();
    }
    return promoted > 0;
  }

  /** Try to take ownership of another worker's mirror. False when someone else already did. */
  async #claimMirror(instanceId: string): Promise<boolean> {
    try {
      return await this.#store.clearMirror(instanceId);
    } catch {
      return false;
    }
  }

  /**
   * Look for abandoned mirrors again, long after the mount.
   *
   * On a reconnect the previous worker's mirror is still fresh, so `start()` correctly leaves
   * it alone — but the window it holds would then wait for some unrelated future mount. Coming
   * back once it has gone stale keeps recovery bounded by the staleness threshold instead.
   */
  #maybeScanForOrphans(): void {
    if (!this.#cacheAvailable) {
      return;
    }
    const scanIntervalMs = this.#mirrorIntervalMs * MIRROR_STALE_INTERVALS;
    if (this.#now() - this.#lastOrphanScanAt < scanIntervalMs) {
      return;
    }
    this.#lastOrphanScanAt = this.#now();
    this.#enqueueCacheOp(async () => {
      if (await this.#promoteOrphanMirrors()) {
        await this.#evictToCap();
        this.#broadcastClips();
      }
    });
  }

  /**
   * Recovery is a single rolling slot. Every reload and reconnect promotes the previous
   * worker's mirror, so without this the cache fills with `recovered` clips and the cap
   * starts dropping the clips the user actually asked for.
   */
  async #pruneRecovered(): Promise<void> {
    const recovered = (await this.#store.listClips()).filter(
      (clip) => clip.trigger === "recovered",
    );
    // listClips is oldest first, so everything but the last is superseded.
    for (const clip of recovered.slice(0, -1)) {
      await this.#store.deleteClip(clip.id);
    }
  }

  /**
   * Drop whole clips until the cache is back under the cap. Returns whether anything was
   * removed. The live ring and the mirror are never touched, and at least one clip is
   * always kept — a single clip larger than the cap stays rather than being written and
   * instantly deleted.
   *
   * Order is oldest-first, except that `recovered` clips go before anything the user asked
   * for however new they are. Recovery is churn produced by reconnects, so it must never
   * cost a `gap`, `manual`, or auto-save window.
   */
  async #evictToCap(reserveBytes = 0): Promise<boolean> {
    const cap = this.#maxCacheBytes;
    if (cap == undefined) {
      return false;
    }
    // Same plan the panel previews when the user lowers the limit, so what it warned about
    // is exactly what happens here. `reserveBytes` leaves room for a clip about to be written.
    const target = Math.max(0, cap - reserveBytes);
    const doomed = planEviction(await this.#store.listClips(), target);
    for (const victim of doomed) {
      await this.#store.deleteClip(victim.id);
    }
    if (doomed.length > 0) {
      this.#clips = await this.#store.listClips();
      return true;
    }
    return false;
  }

  #buildMeta(
    snapshot: readonly DvrRecord[],
    byteSize: number,
    spec: { trigger: ClipTrigger; triggerLabel: string; sealed: boolean },
  ): ClipMeta {
    const topicCounts: Record<string, number> = {};
    const topicBytes: Record<string, number> = {};
    for (const record of snapshot) {
      topicCounts[record.topic] = (topicCounts[record.topic] ?? 0) + 1;
      topicBytes[record.topic] = (topicBytes[record.topic] ?? 0) + record.data.byteLength;
    }
    const startNanos = snapshot[0]?.logTime ?? 0n;
    const endNanos = snapshot[snapshot.length - 1]?.logTime ?? 0n;
    const spanNanos = endNanos - startNanos;
    return {
      id: this.#nextClipId(),
      trigger: spec.trigger,
      triggerLabel: spec.triggerLabel,
      startNanos: startNanos.toString(),
      endNanos: endNanos.toString(),
      durationSec: spanNanos > 0n ? Number(spanNanos) / 1e9 : 0,
      byteSize,
      messageCount: snapshot.length,
      topicCounts,
      topicBytes,
      createdAt: this.#now(),
      sealed: spec.sealed,
    };
  }

  /**
   * Clip ids double as OPFS filenames in a cache shared by every panel at the origin, so
   * they carry this worker's instance id. Without it two panels reacting to the same event
   * in the same millisecond derive the same id — both seed `#seq` from the same clip count
   * — and collide on one file, which OPFS rejects outright. The sequence number is padded
   * so ids from a single millisecond still sort in creation order.
   */
  #nextClipId(): string {
    const seq = this.#seq++;
    return `clip-${this.#now()}-${String(seq).padStart(4, "0")}-${this.#store.instanceId()}`;
  }

  #broadcastClips(): void {
    this.#emit({ type: "clips", clips: this.#clips, cache: this.cacheStatus() });
  }

  /** False when there is no durable cache; warns the panel once. */
  #requireCache(): boolean {
    if (this.#cacheAvailable) {
      return true;
    }
    if (!this.#warnedUnavailable) {
      this.#warnedUnavailable = true;
      this.#emit({
        type: "error",
        message: "Clip cache unavailable — browser storage (OPFS) is not usable here",
      });
    }
    return false;
  }

  // --- gap + mirror ----------------------------------------------------------------

  #checkGap(): void {
    const gapMs = this.#gapMs;
    if (gapMs == undefined || gapMs <= 0) {
      return; // trigger disabled
    }
    const lastMessageAt = this.#lastMessageAt;
    if (lastMessageAt == undefined || !this.#gapArmed) {
      return; // nothing received yet, or this gap already fired
    }
    if (this.#now() - lastMessageAt <= gapMs) {
      return;
    }
    // Fire once per gap; the next message re-arms it.
    this.#gapArmed = false;
    this.#requestClip("gap", `gap>${Math.round(gapMs / 1000)}s`);
  }

  /**
   * Write the live window to the store on a throttle, as an un-sealed mirror. This is
   * the crash-recovery backstop for the window between clips; it never resets the ring.
   */
  #maybeMirror(): void {
    if (!this.#cacheAvailable || this.#mirrorInFlight || this.#records.length === 0) {
      return;
    }
    if (this.#messageCount === this.#mirroredMessageCount) {
      return; // nothing new since the last mirror
    }
    // The interval is a floor, not a promise: once a mirror costs real time, wait in
    // proportion to that cost so the work cannot grow with the ring on a fixed timer.
    const minimumGapMs = Math.max(
      this.#mirrorIntervalMs,
      this.#lastMirrorCostMs * MIRROR_COST_MULTIPLIER,
    );
    if (this.#now() - this.#lastMirrorAt < minimumGapMs) {
      return;
    }
    const snapshot = this.#records.slice();
    const schemas = this.#snapshotSchemaMap();
    const mirroredCount = this.#messageCount;
    this.#mirrorInFlight = true;
    this.#lastMirrorAt = this.#now();
    // Unguarded `#enqueue` on purpose: the in-flight flag must be released even when the
    // cache turned out to be unusable while this was queued.
    this.#enqueue(async () => {
      const startedAt = this.#now();
      try {
        if (!this.#cacheAvailable) {
          return;
        }
        const bytes = await this.#frame(snapshot, schemas);
        const meta = this.#buildMeta(snapshot, bytes.byteLength, {
          trigger: "recovered",
          triggerLabel: TRIGGER_LABELS.recovered,
          sealed: false,
        });
        // The heartbeat is what tells another worker this mirror is still being tended.
        await this.#store.writeMirror({ ...meta, updatedAt: this.#now() }, bytes);
        this.#mirroredMessageCount = mirroredCount;
      } finally {
        this.#mirrorInFlight = false;
        this.#lastMirrorCostMs = Math.max(0, this.#now() - startedAt);
        // Measure the gap from the end of the work, not its start, so a slow mirror does not
        // immediately become eligible again.
        this.#lastMirrorAt = this.#now();
      }
    });
  }

  // --- live ring -------------------------------------------------------------------

  /**
   * Insert keeping `#records` sorted ascending by `logTime`. Messages usually arrive in
   * publish-time order (fast-path push at the tail), but a source that jumps time
   * backward (a looping replay, say) can deliver out-of-order times. Staying sorted means
   * `#records[0]` is always the min-`logTime` record and the last is the max, so span
   * reporting and oldest-first eviction stay correct.
   */
  #insertRecord(record: DvrRecord): void {
    const n = this.#records.length;
    const last = this.#records[n - 1];
    if (last == undefined || record.logTime >= last.logTime) {
      this.#records.push(record);
      return;
    }
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const midRecord = this.#records[mid];
      if (midRecord != undefined && midRecord.logTime <= record.logTime) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    this.#records.splice(lo, 0, record);
  }

  /**
   * Enforce the configured budget after a push. With auto-save off this is a true ring
   * (evict oldest). With auto-save on, exceeding the budget snapshots the whole window,
   * clears it synchronously (the re-entrancy guard — the next message starts a fresh
   * window, so a slow build can never double-flush), and kicks off an async build.
   * Schemas persist across windows so every rotated file is self-contained.
   */
  #enforceBudget(): void {
    const budgetNanos = this.#budgetNanos;
    const budgetBytes = this.#budgetBytes;
    if (this.#budgetMode === "time" && budgetNanos != undefined) {
      while (this.#records.length > 1) {
        const oldest = this.#records[0];
        const newest = this.#records[this.#records.length - 1];
        if (oldest == undefined || newest == undefined) {
          break;
        }
        if (newest.logTime - oldest.logTime <= budgetNanos) {
          break;
        }
        if (this.#rotateOrEvict()) {
          break; // rotation cleared the buffer; nothing left to trim
        }
      }
    } else if (this.#budgetMode === "bytes" && budgetBytes != undefined) {
      while (this.#records.length > 0 && this.#byteTotal > budgetBytes) {
        if (this.#rotateOrEvict()) {
          break;
        }
      }
    }
  }

  /**
   * Evict the oldest record (ring) or rotate the whole window (auto-save). Returns true
   * when a rotation cleared the buffer, so the caller stops looping.
   */
  #rotateOrEvict(): boolean {
    if (this.#autoSave) {
      const snapshot = this.#records.slice();
      const snapshotSchemas = this.#snapshotSchemaMap();
      this.#records.length = 0;
      this.#byteTotal = 0;
      this.#rotations++;
      this.#mirroredMessageCount = -1;
      // Cache the window first. Rotation has already dropped it from the live ring, so if
      // the folder write cannot complete there is nothing left to fall back on: a folder's
      // read-write grant lapses to "prompt" across a page load, and this code path has no
      // user gesture, so it can only query the grant and must pause. The cache is the
      // guarantee; the folder write below is opportunistic.
      this.#cacheSnapshot(snapshot, snapshotSchemas, "rotation", TRIGGER_LABELS.rotation);
      this.#flushRotation(snapshot, snapshotSchemas);
      this.#postStat();
      return true;
    }
    // `#records` is sorted by logTime, so index 0 is the oldest record — shifting it
    // always shrinks the buffered span (unlike shifting by arrival order, which can leave
    // the min/max untouched and over-evict the window under out-of-order times).
    const gone = this.#records.shift();
    if (gone != undefined) {
      this.#byteTotal -= gone.data.byteLength;
    }
    return false;
  }

  /** Async-frame a rotated window and post it as a rotation "saved" event. */
  #flushRotation(snapshot: DvrRecord[], schemas: Map<string, DvrSchema>): void {
    this.#frame(snapshot, schemas)
      .then((bytes) => {
        this.#emitBuffer(bytes, "rotation");
      })
      .catch((err: unknown) => {
        this.#emitError(err);
      });
  }

  /** Freeze the current per-topic schemas into the framing shape (name/encoding/data). */
  #snapshotSchemaMap(): Map<string, DvrSchema> {
    const schemas = new Map<string, DvrSchema>();
    for (const [topic, entry] of this.#schemaByTopic) {
      schemas.set(topic, {
        name: entry.name,
        encoding: "jsonschema",
        data: this.#encoder.encode(JSON.stringify(entry.schema)),
      });
    }
    return schemas;
  }

  #encodeMessage(message: unknown): Uint8Array {
    try {
      if (message == undefined) {
        return this.#encoder.encode("null");
      }
      return this.#encoder.encode(JSON.stringify(message, jsonReplacer));
    } catch (err) {
      return this.#encoder.encode(JSON.stringify({ __dvr_encode_error: String(err) }));
    }
  }

  // --- plumbing --------------------------------------------------------------------

  #postStat(): void {
    this.#lastStatMessageCount = this.#messageCount;
    this.#emit(this.stats());
  }

  #emitBuffer(bytes: Uint8Array, kind: "manual" | "rotation"): void {
    const buffer = toArrayBuffer(bytes);
    this.#emit(
      {
        type: "saved",
        buffer,
        messageCount: this.#messageCount,
        channels: this.#schemaByTopic.size,
        rotation: kind === "rotation",
      },
      [buffer],
    );
  }

  #emitError(err: unknown): void {
    this.#emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }

  /**
   * Queue a store operation. Serializing them means one writer at a time (no OPFS handle
   * races, no overlapping MCAP builds) and a stable order. A rejection is reported and
   * swallowed so the chain — and live capture — keep running.
   */
  #enqueue(operation: () => Promise<void>): void {
    this.#queue = this.#queue.then(operation).catch((err: unknown) => {
      this.#emitError(err);
    });
  }

  /**
   * Like {@link CaptureEngine.#enqueue}, but skipped when the durable cache turned out to
   * be unusable. The caller's synchronous `#requireCache()` check can be stale: a request
   * may be queued behind a `start()` whose `store.init()` is still pending.
   */
  #enqueueCacheOp(operation: () => Promise<void>): void {
    this.#enqueue(async () => {
      if (!this.#cacheAvailable) {
        return;
      }
      await operation();
    });
  }
}

/** Reject if `work` has not settled within `ms`. The timer is always cleared. */
async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
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

function toNanos(time?: Time): bigint {
  if (time == undefined) {
    return 0n;
  }
  return BigInt(time.sec) * 1_000_000_000n + BigInt(time.nsec);
}

/** Detach a view into its own transferable ArrayBuffer. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function toBase64(view: ArrayBufferView): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + chunkSize) as unknown as number[],
    );
  }
  return btoa(binary);
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    // JSON has no 64-bit integer. Within the double-safe range a number is what consumers
    // expect from an integer field, but past it a number would be a *different* value — so
    // emit the exact decimal string instead of silently rounding. (inferSchema already types
    // bigint fields as strings, so a string is the more consistent of the two.)
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  // Unsigned byte arrays -> base64 string (matches contentEncoding:base64 in the schema).
  // Int8Array is intentionally NOT base64'd: the app's normalizeInt8Array
  // (OccupancyGrid.data) rejects a Uint8Array, so it must stay a number array.
  if (value instanceof Uint8Array) {
    return toBase64(value);
  }
  // Other typed arrays (Int8Array, Float32Array, etc.) -> plain number arrays.
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return Array.from(value as unknown as ArrayLike<number>);
  }
  return value;
}

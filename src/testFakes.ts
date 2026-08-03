// Test doubles for the capture engine. Kept out of the test file so the engine's
// dependencies are described in one place, and so the fake store is written against the
// real `ClipStore` interface rather than an ad-hoc shape.
//
// The key idea is `FakeBacking`: one in-memory "disk" that outlives any store view over
// it. A second `createFakeClipStore(backing, { instanceId })` with a *different* instance
// id is the app-free stand-in for a worker teardown and restart — the new view sees the
// clips the old one wrote, and sees the old view's mirror as an orphan, exactly as a
// freshly-created worker sees what OPFS kept after the previous one was terminated.

import { EngineInboundMsg, EngineOutput, FrameFn } from "./captureEngine";
import { ClipMeta } from "./clipTypes";
import { ClipStore, ClipStoreMode, MirrorEntry } from "./opfsStore";

type StoredFile = { meta: ClipMeta; bytes: Uint8Array };

/** The shared in-memory disk. Survives any number of store views over it. */
export type FakeBacking = {
  clips: Map<string, StoredFile>;
  /** Keyed by the owning worker-instance id. */
  mirrors: Map<string, StoredFile>;
};

export function createFakeBacking(): FakeBacking {
  return { clips: new Map(), mirrors: new Map() };
}

export type FakeStoreOptions = {
  /** Identifies the "worker instance" owning this view's mirror. */
  instanceId?: string;
  mode?: ClipStoreMode;
  /** Make `init()` reject, as an unsupported or blocked OPFS would. */
  failInit?: boolean;
  /** Make `writeClip()` reject, as a quota failure would. */
  failWrites?: boolean;
  /**
   * Mirrors that cannot be deleted, as OPFS reports while another worker holds the file.
   * Keyed by owning instance id.
   */
  lockedMirrors?: Set<string>;
};

/** A `ClipStore` over an in-memory backing. Deep-copies bytes, like a real filesystem. */
export function createFakeClipStore(backing: FakeBacking, opts: FakeStoreOptions = {}): ClipStore {
  const instanceId = opts.instanceId ?? "instance-a";
  const mode: ClipStoreMode = opts.mode ?? "async";

  const sorted = (): ClipMeta[] =>
    Array.from(backing.clips.values())
      .map((entry) => entry.meta)
      .sort((a, b) =>
        a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt - b.createdAt,
      );

  return {
    init: async (): Promise<void> => {
      if (opts.failInit === true) {
        throw new Error("fake OPFS unavailable");
      }
    },
    mode: (): ClipStoreMode => (opts.failInit === true ? "unavailable" : mode),
    instanceId: (): string => instanceId,
    writeClip: async (meta: ClipMeta, bytes: Uint8Array): Promise<void> => {
      if (opts.failWrites === true) {
        throw new Error("fake quota exceeded");
      }
      backing.clips.set(meta.id, { meta, bytes: bytes.slice() });
    },
    listClips: async (): Promise<ClipMeta[]> => sorted(),
    readClip: async (id: string): Promise<Uint8Array | undefined> =>
      backing.clips.get(id)?.bytes.slice(),
    deleteClip: async (id: string): Promise<void> => {
      backing.clips.delete(id);
    },
    clearClips: async (): Promise<void> => {
      backing.clips.clear();
    },
    totalClipBytes: async (): Promise<number> =>
      sorted().reduce((total, meta) => total + meta.byteSize, 0),
    writeMirror: async (meta: ClipMeta, bytes: Uint8Array): Promise<void> => {
      backing.mirrors.set(instanceId, { meta, bytes: bytes.slice() });
    },
    listOrphanMirrors: async (): Promise<MirrorEntry[]> => {
      const orphans: MirrorEntry[] = [];
      for (const [owner, entry] of backing.mirrors) {
        if (owner !== instanceId) {
          orphans.push({ instanceId: owner, meta: entry.meta, bytes: entry.bytes.slice() });
        }
      }
      return orphans;
    },
    clearMirror: async (target?: string): Promise<void> => {
      const id = target ?? instanceId;
      if (opts.lockedMirrors?.has(id) === true) {
        throw new Error(`fake OPFS: ${id} mirror is locked by its owner`);
      }
      backing.mirrors.delete(id);
    },
  };
}

export type FakeClock = {
  now: () => number;
  advance: (ms: number) => void;
};

/** A hand-cranked clock, so no test depends on real time passing. */
export function createFakeClock(startMs = 1_700_000_000_000): FakeClock {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

export type OutputCollector = {
  emit: (message: EngineOutput) => void;
  outputs: EngineOutput[];
  /** Every output of one kind, oldest first. */
  all: <T extends EngineOutput["type"]>(type: T) => Array<Extract<EngineOutput, { type: T }>>;
  /** The most recent output of one kind, if any. */
  last: <T extends EngineOutput["type"]>(type: T) => Extract<EngineOutput, { type: T }> | undefined;
  clear: () => void;
};

export function collectOutputs(): OutputCollector {
  const outputs: EngineOutput[] = [];
  const all = <T extends EngineOutput["type"]>(
    type: T,
  ): Array<Extract<EngineOutput, { type: T }>> =>
    outputs.filter((output): output is Extract<EngineOutput, { type: T }> => output.type === type);
  return {
    emit: (message: EngineOutput) => {
      outputs.push(message);
    },
    outputs,
    all,
    last: <T extends EngineOutput["type"]>(
      type: T,
    ): Extract<EngineOutput, { type: T }> | undefined => {
      const matching = all(type);
      return matching[matching.length - 1];
    },
    clear: () => {
      outputs.length = 0;
    },
  };
}

/** A framer producing a fixed byte count, so cache-eviction math is exact. */
export function sizedFrame(byteSize: number): FrameFn {
  return async () => new Uint8Array(byteSize);
}

/** A framer that never settles, for testing the mirror's overlap guard. */
export function blockingFrame(): { frame: FrameFn; calls: () => number } {
  let calls = 0;
  return {
    frame: async () => {
      calls++;
      return await new Promise<Uint8Array>(() => {
        // never resolves
      });
    },
    calls: () => calls,
  };
}

/** A message on `topic` whose publish time is `sec` seconds (plus `nsec`). */
export function makeMsg(
  topic: string,
  sec: number,
  extra: { nsec?: number; message?: unknown } = {},
): EngineInboundMsg {
  return {
    topic,
    schemaName: topic,
    publishTime: { sec, nsec: extra.nsec ?? 0 },
    message: extra.message ?? { value: sec },
  };
}

/** The nanosecond `logTime` a message built by {@link makeMsg} lands on. */
export function nanosOf(sec: number, nsec = 0): bigint {
  return BigInt(sec) * 1_000_000_000n + BigInt(nsec);
}

/** A minimal un-sealed mirror record, for seeding a "dead worker" into the backing. */
export function makeMirrorMeta(overrides: Partial<ClipMeta> = {}): ClipMeta {
  return {
    id: "mirror",
    trigger: "recovered",
    triggerLabel: "recovered",
    startNanos: nanosOf(100).toString(),
    endNanos: nanosOf(110).toString(),
    durationSec: 10,
    byteSize: 64,
    messageCount: 3,
    topicCounts: { "/a": 2, "/b": 1 },
    createdAt: 1_699_999_000_000,
    sealed: false,
    ...overrides,
  };
}

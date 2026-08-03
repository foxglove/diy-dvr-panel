// OPFS (Origin Private File System) store for the durable clip cache.
//
// The host app re-runs `initPanel` whenever the live connection's presence or context
// changes (a WebSocket reconnect, for example), which terminates the panel's Web Worker
// and discards its in-memory buffer. OPFS lives at the origin and outlives any single
// worker, so clips written here survive that teardown and are re-read on the next mount.
//
// Shape mirrors `fsStore.ts`: a few small private helpers plus a narrow exported surface.
// Unlike `fsStore.ts` (which persists one structured-cloneable handle in IndexedDB) this
// module owns real files, so it is returned as an injectable `ClipStore` object — the
// capture engine takes one, and the unit tests pass an in-memory fake instead.
//
// Layout, all under a `diy-dvr` root so we never touch anything else at the origin:
//
//   diy-dvr/clips/<id>.mcap    framed clip bytes
//   diy-dvr/clips/<id>.json    ClipMeta sidecar, written AFTER the payload
//   diy-dvr/mirror/<inst>.part un-sealed mirror of one worker's live ring buffer
//   diy-dvr/mirror/<inst>.json ClipMeta sidecar, written AFTER the payload
//
// The sidecar is always written last so it acts as a commit marker: a torn write reads
// back as "no clip" rather than as a clip with bogus metadata.
//
// Mirror files are named per *worker instance* rather than a single `current.part`. OPFS
// is shared by every panel instance at the origin, OPFS enforces exclusive file access,
// and `PanelExtensionContext` exposes no panel id — so two DIY DVR panels writing one
// mirror path would collide. With one file each, a fresh worker promotes every mirror it
// does not own (see `listOrphanMirrors`) and leaves its own alone.
//
// Sync vs async access handles (decided at runtime, see `writeFile`/`readFile`):
// `FileSystemSyncAccessHandle` is not available in every worker across the web and
// desktop builds, so both paths are implemented behind one API and the store reports
// which one is live via `mode()`.

import { ClipMeta } from "./clipTypes";

const ROOT_DIR = "diy-dvr";
const CLIPS_DIR = "clips";
const MIRROR_DIR = "mirror";
const CLIP_EXT = ".mcap";
const MIRROR_EXT = ".part";
const META_EXT = ".json";
// Per instance, never a shared name: OPFS enforces exclusive file access, so two panels
// probing one path would race and one of them would see NoModificationAllowedError.
const PROBE_PREFIX = ".probe-";

// --- Minimal declarations for OPFS APIs missing from the TS 5.1 DOM lib ------------
// (Same approach as `FileSystemHandlePermissions` in DvrPanel.tsx: declare the shape
// instead of casting to `any`.)

/** https://developer.mozilla.org/docs/Web/API/FileSystemSyncAccessHandle */
type FileSystemSyncAccessHandle = {
  getSize: () => number;
  read: (buffer: ArrayBufferView, options?: { at?: number }) => number;
  write: (buffer: ArrayBufferView, options?: { at?: number }) => number;
  truncate: (newSize: number) => void;
  flush: () => void;
  close: () => void;
};

/** `createSyncAccessHandle` only exists in worker contexts, and not in every build. */
type SyncCapableFileHandle = FileSystemFileHandle & {
  createSyncAccessHandle?: () => Promise<FileSystemSyncAccessHandle>;
};

/** The async-iterable directory accessors are not in the TS 5.1 DOM lib. */
type EnumerableDirectoryHandle = FileSystemDirectoryHandle & {
  keys?: () => AsyncIterableIterator<string>;
};

/** `navigator.storage` is typed as always present; treat it as optional at runtime. */
type OpfsCapableStorage = { getDirectory?: () => Promise<FileSystemDirectoryHandle> };

// --- Public API --------------------------------------------------------------------

/** Which OPFS access path is live. `unknown` until the first successful `init()`. */
export type ClipStoreMode = "unknown" | "sync" | "async" | "unavailable";

/** A mirror file with its metadata, as found on disk. */
export type MirrorEntry = {
  instanceId: string;
  meta: ClipMeta;
  bytes: Uint8Array;
};

/**
 * Everything the capture engine needs from durable storage. The engine only ever sees
 * this interface, so the OPFS implementation and the in-memory test fake are
 * interchangeable and neither the engine nor the panel branches on which is active.
 */
export type ClipStore = {
  /** Prepare the directories and resolve the access mode. Rejects when OPFS is unusable. */
  init: () => Promise<void>;
  /** Which access path is live, for display in the panel. */
  mode: () => ClipStoreMode;
  /**
   * Identifies this worker instance. The cache is shared by every panel at the origin, so
   * callers must fold this into any name they invent to stay collision-free.
   */
  instanceId: () => string;
  writeClip: (meta: ClipMeta, bytes: Uint8Array) => Promise<void>;
  /** Cached clips, oldest first. Clips with a missing payload or sidecar are skipped. */
  listClips: () => Promise<ClipMeta[]>;
  readClip: (id: string) => Promise<Uint8Array | undefined>;
  deleteClip: (id: string) => Promise<void>;
  clearClips: () => Promise<void>;
  totalClipBytes: () => Promise<number>;
  /** Overwrite this instance's mirror of the live ring buffer. */
  writeMirror: (meta: ClipMeta, bytes: Uint8Array) => Promise<void>;
  /** Mirrors belonging to *other* worker instances — i.e. left behind by a dead worker. */
  listOrphanMirrors: () => Promise<MirrorEntry[]>;
  /** Delete a mirror. Defaults to this instance's own. */
  clearMirror: (instanceId?: string) => Promise<void>;
};

/**
 * Create an OPFS-backed clip store. `instanceId` identifies this worker's mirror file and
 * defaults to a fresh random id, so every worker instance owns exactly one mirror.
 */
export function createOpfsStore(instanceId: string = randomInstanceId()): ClipStore {
  const ownId = sanitizeId(instanceId);
  let mode: ClipStoreMode = "unknown";
  let dirsPromise: Promise<OpfsDirs> | undefined;
  // Latched once a sync access handle fails, so we stop paying for a doomed attempt on
  // every write. Some builds expose the method but reject when it is called.
  let syncBroken = false;

  type OpfsDirs = {
    root: FileSystemDirectoryHandle;
    clips: FileSystemDirectoryHandle;
    mirror: FileSystemDirectoryHandle;
  };

  async function openDirs(): Promise<OpfsDirs> {
    const storage: OpfsCapableStorage | undefined =
      typeof navigator === "undefined" ? undefined : navigator.storage;
    const getDirectory = storage?.getDirectory?.bind(storage);
    if (getDirectory == undefined) {
      mode = "unavailable";
      throw new Error("OPFS is unavailable (navigator.storage.getDirectory is missing)");
    }
    try {
      const origin = await getDirectory();
      const root = await origin.getDirectoryHandle(ROOT_DIR, { create: true });
      const clips = await root.getDirectoryHandle(CLIPS_DIR, { create: true });
      const mirror = await root.getDirectoryHandle(MIRROR_DIR, { create: true });
      return { root, clips, mirror };
    } catch (err) {
      mode = "unavailable";
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  async function dirs(): Promise<OpfsDirs> {
    dirsPromise ??= openDirs();
    return await dirsPromise;
  }

  /**
   * Run an operation against the cache directories, re-opening them once if they turn out
   * to be gone. The handles are memoized, so anything that removes the directory from
   * underneath us — the browser's "clear site data", most plausibly — would otherwise make
   * every later call fail with a raw `NotFoundError` until the panel is reloaded.
   */
  async function withDirs<T>(operation: (open: OpfsDirs) => Promise<T>): Promise<T> {
    try {
      return await operation(await dirs());
    } catch (err) {
      if (!isNotFound(err)) {
        throw err;
      }
      dirsPromise = undefined;
      return await operation(await dirs());
    }
  }

  /**
   * Write a whole file, preferring a synchronous access handle. The sync path is the
   * simplest and fastest option for the throttled mirror, but it does not exist
   * everywhere, so any failure latches a permanent fall back to the async writable.
   */
  async function writeFile(
    dir: FileSystemDirectoryHandle,
    name: string,
    bytes: Uint8Array,
  ): Promise<void> {
    const handle = await dir.getFileHandle(name, { create: true });
    const openSync = syncBroken
      ? undefined
      : (handle as SyncCapableFileHandle).createSyncAccessHandle;
    if (openSync != undefined) {
      try {
        const sync = await openSync.call(handle);
        try {
          sync.truncate(0);
          sync.write(bytes, { at: 0 });
          sync.flush();
        } finally {
          sync.close();
        }
        mode = "sync";
        return;
      } catch {
        syncBroken = true;
      }
    }
    const writable = await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
    mode = "async";
  }

  /** Read a whole file, or `undefined` when it does not exist. */
  async function readFile(
    dir: FileSystemDirectoryHandle,
    name: string,
  ): Promise<Uint8Array | undefined> {
    let handle: FileSystemFileHandle;
    try {
      handle = await dir.getFileHandle(name);
    } catch (err) {
      if (isNotFound(err)) {
        return undefined;
      }
      throw err;
    }
    const openSync = syncBroken
      ? undefined
      : (handle as SyncCapableFileHandle).createSyncAccessHandle;
    if (openSync != undefined) {
      try {
        const sync = await openSync.call(handle);
        try {
          const bytes = new Uint8Array(sync.getSize());
          sync.read(bytes, { at: 0 });
          mode = "sync";
          return bytes;
        } finally {
          sync.close();
        }
      } catch {
        syncBroken = true;
      }
    }
    const file = await handle.getFile();
    mode = "async";
    return new Uint8Array(await file.arrayBuffer());
  }

  /** Every entry name in a directory. Throws when the runtime cannot enumerate. */
  async function listNames(dir: FileSystemDirectoryHandle): Promise<string[]> {
    const keys = (dir as EnumerableDirectoryHandle).keys?.bind(dir);
    if (keys == undefined) {
      throw new Error("OPFS is unavailable (directory enumeration is missing)");
    }
    const names: string[] = [];
    for await (const name of keys()) {
      names.push(name);
    }
    return names;
  }

  async function readMeta(
    dir: FileSystemDirectoryHandle,
    name: string,
  ): Promise<ClipMeta | undefined> {
    const bytes = await readFile(dir, name);
    if (bytes == undefined) {
      return undefined;
    }
    return decodeMeta(bytes);
  }

  /** Ids that have both a payload and a readable sidecar, paired with their metadata. */
  async function readIndex(
    dir: FileSystemDirectoryHandle,
    payloadExt: string,
  ): Promise<Array<{ id: string; meta: ClipMeta }>> {
    const names = new Set(await listNames(dir));
    const found: Array<{ id: string; meta: ClipMeta }> = [];
    for (const name of names) {
      if (!name.endsWith(META_EXT)) {
        continue;
      }
      const id = name.slice(0, name.length - META_EXT.length);
      if (!names.has(id + payloadExt)) {
        continue; // torn or half-deleted pair — ignore it
      }
      const meta = await readMeta(dir, name);
      if (meta != undefined) {
        found.push({ id, meta });
      }
    }
    return found;
  }

  async function listClips(): Promise<ClipMeta[]> {
    return await withDirs(async ({ clips }) => {
      const found = await readIndex(clips, CLIP_EXT);
      return found.map((entry) => entry.meta).sort(compareByCreation);
    });
  }

  return {
    init: async (): Promise<void> => {
      const { root, clips } = await dirs();
      try {
        // Enumeration backs both the clip list and orphan-mirror discovery, so check it
        // here rather than failing later.
        await listNames(clips);
      } catch (err) {
        mode = "unavailable";
        throw err instanceof Error ? err : new Error(String(err));
      }
      // A real write/read/delete round trip resolves sync-vs-async up front, so the panel
      // can report the live mode from its very first clip broadcast. Best effort only: the
      // directories are already known good, so a probe failure must not disable the cache
      // — it just leaves the mode unresolved until the first real write.
      const probeName = PROBE_PREFIX + ownId;
      try {
        await writeFile(root, probeName, new Uint8Array([1]));
        await readFile(root, probeName);
        await removeIfPresent(root, probeName);
      } catch {
        // Leave `mode` unresolved and carry on; the cache itself is fine.
      }
    },

    mode: (): ClipStoreMode => mode,

    instanceId: (): string => ownId,

    writeClip: async (meta: ClipMeta, bytes: Uint8Array): Promise<void> => {
      await withDirs(async ({ clips }) => {
        await writeFile(clips, meta.id + CLIP_EXT, bytes);
        await writeFile(clips, meta.id + META_EXT, encodeMeta(meta));
      });
    },

    listClips,

    readClip: async (id: string): Promise<Uint8Array | undefined> =>
      await withDirs(async ({ clips }) => await readFile(clips, id + CLIP_EXT)),

    deleteClip: async (id: string): Promise<void> => {
      await withDirs(async ({ clips }) => {
        // Sidecar first: without it the payload is already invisible to `listClips`, so a
        // half-finished delete never leaves metadata pointing at missing bytes.
        await removeIfPresent(clips, id + META_EXT);
        await removeIfPresent(clips, id + CLIP_EXT);
      });
    },

    clearClips: async (): Promise<void> => {
      const { root } = await dirs();
      await removeIfPresent(root, CLIPS_DIR, { recursive: true });
      // The cached handle for the removed directory is stale; re-open everything.
      dirsPromise = undefined;
      await dirs();
    },

    totalClipBytes: async (): Promise<number> => {
      const metas = await listClips();
      return metas.reduce((total, meta) => total + meta.byteSize, 0);
    },

    writeMirror: async (meta: ClipMeta, bytes: Uint8Array): Promise<void> => {
      await withDirs(async ({ mirror }) => {
        await writeFile(mirror, ownId + MIRROR_EXT, bytes);
        await writeFile(mirror, ownId + META_EXT, encodeMeta(meta));
      });
    },

    listOrphanMirrors: async (): Promise<MirrorEntry[]> =>
      await withDirs(async ({ mirror }) => {
        const found = await readIndex(mirror, MIRROR_EXT);
        const orphans: MirrorEntry[] = [];
        for (const entry of found) {
          if (entry.id === ownId) {
            continue; // our own live mirror
          }
          try {
            const bytes = await readFile(mirror, entry.id + MIRROR_EXT);
            if (bytes != undefined) {
              orphans.push({ instanceId: entry.id, meta: entry.meta, bytes });
            }
          } catch {
            // Unreadable, typically because a live panel holds the file. Skip it rather than
            // failing the whole rehydrate; the cached clips still load.
          }
        }
        return orphans.sort((a, b) => compareByCreation(a.meta, b.meta));
      }),

    clearMirror: async (instanceToClear?: string): Promise<void> => {
      await withDirs(async ({ mirror }) => {
        const id = instanceToClear == undefined ? ownId : sanitizeId(instanceToClear);
        await removeIfPresent(mirror, id + META_EXT);
        await removeIfPresent(mirror, id + MIRROR_EXT);
      });
    },
  };
}

// --- Helpers ----------------------------------------------------------------------

function encodeMeta(meta: ClipMeta): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(meta));
}

/** Parse a sidecar, returning `undefined` for anything that is not usable metadata. */
function decodeMeta(bytes: Uint8Array): ClipMeta | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined; // torn or corrupt sidecar
  }
  if (typeof parsed !== "object" || parsed == undefined) {
    return undefined;
  }
  const meta = parsed as Partial<ClipMeta>;
  if (
    typeof meta.id !== "string" ||
    typeof meta.createdAt !== "number" ||
    typeof meta.byteSize !== "number"
  ) {
    return undefined;
  }
  return parsed as ClipMeta;
}

/** Oldest first, with the id as a stable tiebreak for clips created in the same ms. */
function compareByCreation(a: ClipMeta, b: ClipMeta): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt - b.createdAt;
  }
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? -1 : 1;
}

async function removeIfPresent(
  dir: FileSystemDirectoryHandle,
  name: string,
  options?: FileSystemRemoveOptions,
): Promise<void> {
  try {
    await dir.removeEntry(name, options);
  } catch (err) {
    if (!isNotFound(err)) {
      throw err;
    }
  }
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err == undefined) {
    return false;
  }
  return (err as { name?: string }).name === "NotFoundError";
}

/** Keep ids usable as filenames. */
function sanitizeId(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, "_");
  return safe.length > 0 ? safe : "instance";
}

function randomInstanceId(): string {
  const cryptoObj: { randomUUID?: () => string } | undefined =
    typeof crypto === "undefined" ? undefined : crypto;
  const uuid = cryptoObj?.randomUUID?.();
  if (uuid != undefined) {
    return uuid;
  }
  return `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

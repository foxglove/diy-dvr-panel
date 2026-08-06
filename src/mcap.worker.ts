// Web Worker: the panel's capture host.
//
// Bundled to a string by scripts/bundle-worker.mjs (esbuild, with @mcap/core) and
// instantiated from a Blob URL by the panel, so it travels inside the extension bundle.
//
// This file is deliberately thin: all capture, clip, mirror, and eviction logic lives in
// `captureEngine.ts`, which holds no worker or DOM references and is unit-tested in Node.
// The adapter's whole job is to bind that engine to the things only a worker has — the
// real OPFS store, `Date.now`, `postMessage`, and a periodic timer — and to translate the
// inbound/outbound message unions.

import { CaptureEngine, EngineInboundMsg, EngineOutput } from "./captureEngine";
import { createOpfsStore } from "./opfsStore";

type InboundMessage =
  | ({ type: "msg" } & EngineInboundMsg)
  | {
      type: "config";
      budgetMode: "time" | "bytes";
      budgetNanos?: bigint;
      budgetBytes?: number;
      autoSave: boolean;
      enabledTopics: string[];
      maxCacheBytes?: number;
      gapMs?: number;
      sourceLabel?: string;
    }
  | { type: "save" }
  | { type: "reset" }
  /** Panel-observed events that should snapshot the buffer into a durable clip. */
  | { type: "trigger"; tag: "backgrounded" | "closing" | "manual-clip" }
  | { type: "deleteClip"; id: string }
  | { type: "clearClips" }
  | { type: "requestClipBytes"; id: string };

// The DOM lib types `self.postMessage` like Window's; cast to the worker shape.
const ctx = self as unknown as {
  onmessage: ((event: { data: InboundMessage }) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};

/**
 * How often the engine is polled. Two jobs need wall-clock time rather than message
 * arrival: the WS-gap trigger and the throttled OPFS mirror.
 *
 * Browsers throttle worker timers while a tab is in the background, so this can slow to a
 * crawl exactly when a gap would fire. That is why the panel also posts an explicit
 * `backgrounded` trigger when the tab is hidden, instead of relying on this alone.
 */
const TICK_INTERVAL_MS = 1000;

const engine = new CaptureEngine({
  store: createOpfsStore(),
  now: () => Date.now(),
  emit: (message: EngineOutput, transfer?: Transferable[]) => {
    ctx.postMessage(message, transfer);
  },
});

// Rehydrate the clip list from OPFS and promote any mirror a previous worker instance left
// behind. This is how clips (and the last mirrored window) survive the panel teardown that
// happens on a reconnect.
engine.start();

setInterval(() => {
  engine.tick();
}, TICK_INTERVAL_MS);

// Announce readiness only once everything above is wired. The panel used to assume the worker
// was ready the moment it was constructed, so a throw at module scope here — a CSP that blocks
// the blob, a missing API — left the panel reporting "Ready" while nothing ever arrived.
ctx.postMessage({ type: "ready" });

ctx.onmessage = (event) => {
  const data = event.data;
  switch (data.type) {
    case "msg":
      engine.addMessage(data);
      break;
    case "config": {
      // Passed through whole rather than copied field by field. The inbound message is the
      // engine's config plus a `type` tag, and listing the fields here meant every new setting
      // had to be remembered in two places — one that was easy to miss, since the engine's own
      // tests configure it directly and never see this hop.
      const { type: _type, ...engineConfig } = data;
      engine.configure(engineConfig);
      break;
    }
    case "save":
      engine.save();
      break;
    case "reset":
      engine.reset();
      break;
    case "trigger":
      engine.createClip(data.tag);
      break;
    case "deleteClip":
      engine.deleteClip(data.id);
      break;
    case "clearClips":
      engine.clearClips();
      break;
    case "requestClipBytes":
      engine.requestClipBytes(data.id);
      break;
  }
};

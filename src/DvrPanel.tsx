import { PanelExtensionContext, SettingsTreeAction, Topic } from "@foxglove/extension";
import * as React from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { MCAP_WORKER_SOURCE } from "./generatedWorkerSource";
import { applyAction, buildSettingsTree, DEFAULT_CONFIG, DvrConfig } from "./settings";

// The File System Access permission methods are not in every TS DOM lib; declare a
// minimal shape rather than `any`-casting. (queryPermission/requestPermission live
// on FileSystemHandle in Chromium.)
type FsPermissionDescriptor = { mode?: "read" | "readwrite" };
type FsPermissionState = "granted" | "denied" | "prompt";
type FileSystemHandlePermissions = {
  queryPermission?: (opts?: FsPermissionDescriptor) => Promise<FsPermissionState>;
  requestPermission?: (opts?: FsPermissionDescriptor) => Promise<FsPermissionState>;
};

// Silent save (directory picker) is Chromium-only. Elsewhere we fall back to a blob
// download. Computed once at module scope so it is not an effect dependency.
const canPickDir = typeof window !== "undefined" && "showDirectoryPicker" in window;

type WorkerStat = {
  messageCount: number;
  channels: number;
  bufferedMsgs: number;
  byteTotal: number;
  oldestNanos: string;
  newestNanos: string;
  rotations: number;
};

const ZERO_STAT: WorkerStat = {
  messageCount: 0,
  channels: 0,
  bufferedMsgs: 0,
  byteTotal: 0,
  oldestNanos: "0",
  newestNanos: "0",
  rotations: 0,
};

// Messages the worker posts back. Kept tolerant of a stale worker build (missing
// extended fields default to zero in the reader).
type OutboundMessage =
  | {
      type: "stat";
      messageCount: number;
      channels: number;
      bufferedMsgs?: number;
      byteTotal?: number;
      oldestNanos?: string;
      newestNanos?: string;
      rotations?: number;
    }
  | {
      type: "saved";
      buffer: ArrayBuffer;
      messageCount: number;
      channels: number;
      rotation?: boolean;
    }
  | { type: "error"; message: string };

/** Blob + anchor download — the fallback when silent directory write is unavailable. */
function downloadMcap(buffer: ArrayBuffer): string {
  const name = `diy-dvr-${Date.now()}.mcap`;
  const blob = new Blob([buffer], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
  return name;
}

/** Silent write into a previously-picked directory (no dialog). */
async function writeMcapFile(
  buffer: ArrayBuffer,
  dirHandle: FileSystemDirectoryHandle,
): Promise<string> {
  const name = `diy-dvr-${Date.now()}.mcap`;
  const fileHandle = await dirHandle.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(buffer);
  await writable.close();
  return name;
}

/** Ensure read-write permission on the directory handle (may re-prompt across sessions). */
async function ensureRwPermission(dirHandle: FileSystemDirectoryHandle): Promise<boolean> {
  const handle = dirHandle as unknown as FileSystemHandlePermissions;
  const opts: FsPermissionDescriptor = { mode: "readwrite" };
  if (handle.queryPermission == undefined) {
    return true; // permission API absent — attempt the write and let it throw if denied
  }
  let perm = await handle.queryPermission(opts);
  if (perm !== "granted" && handle.requestPermission != undefined) {
    perm = await handle.requestPermission(opts);
  }
  return perm === "granted";
}

function statSummary(stat: WorkerStat, config: DvrConfig): { used: string; cap: string } {
  if (config.budgetMode === "time") {
    const spanNanos = BigInt(stat.newestNanos) - BigInt(stat.oldestNanos);
    const usedSec = stat.bufferedMsgs > 0 ? Number(spanNanos) / 1e9 : 0;
    return { used: `${usedSec.toFixed(1)}s`, cap: `${config.budgetValue}s` };
  }
  const usedMb = stat.byteTotal / (1024 * 1024);
  return { used: `${usedMb.toFixed(2)} MB`, cap: `${config.budgetValue} MB` };
}

function DvrPanel({ context }: { context: PanelExtensionContext }): React.JSX.Element {
  const [topics, setTopics] = useState<readonly Topic[]>([]);
  const [forwarded, setForwarded] = useState(0);
  const [stat, setStat] = useState<WorkerStat>(ZERO_STAT);
  const [workerReady, setWorkerReady] = useState(false);
  const [config, setConfig] = useState<DvrConfig>(() => ({
    ...DEFAULT_CONFIG,
    ...(context.initialState as Partial<DvrConfig> | undefined),
  }));
  const [saveFolderName, setSaveFolderName] = useState<string | undefined>(undefined);
  const [lastSaveStatus, setLastSaveStatus] = useState<string>("");

  const workerRef = useRef<Worker | undefined>(undefined);
  const dirHandleRef = useRef<FileSystemDirectoryHandle | undefined>(undefined);

  // Refs mirror the latest config/topics so the (stable) settings action handler
  // never goes stale without being recreated on every render.
  const configRef = useRef(config);
  configRef.current = config;
  const topicsRef = useRef(topics);
  topicsRef.current = topics;

  const enabledTopics = useMemo(
    () => topics.filter((topic) => !config.disabledTopics.includes(topic.name)),
    [topics, config.disabledTopics],
  );

  // Spin up the worker once from a Blob URL (source bundled as a string).
  useEffect(() => {
    const blob = new Blob([MCAP_WORKER_SOURCE], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    worker.onmessage = (event: MessageEvent) => {
      const data = event.data as OutboundMessage;
      switch (data.type) {
        case "stat":
          setStat({
            messageCount: data.messageCount,
            channels: data.channels,
            bufferedMsgs: data.bufferedMsgs ?? 0,
            byteTotal: data.byteTotal ?? 0,
            oldestNanos: data.oldestNanos ?? "0",
            newestNanos: data.newestNanos ?? "0",
            rotations: data.rotations ?? 0,
          });
          break;
        case "saved": {
          setStat((prev) => ({
            ...prev,
            messageCount: data.messageCount,
            channels: data.channels,
          }));
          const buffer = data.buffer;
          const dirHandle = dirHandleRef.current;
          void (async () => {
            if (canPickDir && dirHandle != undefined) {
              try {
                const granted = await ensureRwPermission(dirHandle);
                if (granted) {
                  const name = await writeMcapFile(buffer, dirHandle);
                  setLastSaveStatus(`Saved ${name} → ${dirHandle.name}`);
                  return;
                }
                const name = downloadMcap(buffer);
                setLastSaveStatus(`Permission denied — downloaded ${name}`);
                return;
              } catch (err) {
                const name = downloadMcap(buffer);
                setLastSaveStatus(`Write failed (${String(err)}) — downloaded ${name}`);
                return;
              }
            }
            const name = downloadMcap(buffer);
            setLastSaveStatus(`Downloaded ${name}`);
          })();
          break;
        }
        case "error":
          console.error("[diy-dvr] worker save failed", data.message);
          setLastSaveStatus(`Error: ${data.message}`);
          break;
      }
    };
    worker.onerror = (err) => {
      console.error("[diy-dvr] worker error", err);
    };
    workerRef.current = worker;
    setWorkerReady(true);
    return () => {
      worker.terminate();
      URL.revokeObjectURL(url);
      workerRef.current = undefined;
    };
  }, []);

  // Forward every message from every subscribed topic to the worker.
  useLayoutEffect(() => {
    context.onRender = (renderState, done) => {
      if (renderState.topics) {
        setTopics(renderState.topics);
      }
      const frame = renderState.currentFrame;
      const worker = workerRef.current;
      if (frame && frame.length > 0 && worker) {
        for (const msg of frame) {
          worker.postMessage({
            type: "msg",
            topic: msg.topic,
            schemaName: msg.schemaName,
            receiveTime: msg.receiveTime,
            publishTime: msg.publishTime,
            message: msg.message,
          });
        }
        setForwarded((n) => n + frame.length);
      }
      done();
    };
    context.watch("topics");
    context.watch("currentFrame");
  }, [context]);

  // Subscribe to exactly the enabled topics; re-subscribe when the set changes.
  useEffect(() => {
    context.subscribe(enabledTopics.map((topic) => ({ topic: topic.name })));
  }, [context, enabledTopics]);

  // Push the latest config (resolved budget bounds + enabled set) to the worker.
  useEffect(() => {
    const worker = workerRef.current;
    if (!worker) {
      return;
    }
    worker.postMessage({
      type: "config",
      budgetMode: config.budgetMode,
      budgetNanos:
        config.budgetMode === "time" ? BigInt(Math.round(config.budgetValue * 1e9)) : undefined,
      budgetBytes:
        config.budgetMode === "bytes" ? Math.round(config.budgetValue * 1024 * 1024) : undefined,
      autoSave: config.autoSave,
      enabledTopics: enabledTopics.map((topic) => topic.name),
    });
  }, [config, enabledTopics, workerReady]);

  // Stable settings-editor action handler (reads latest config/topics via refs).
  const actionHandler = useCallback(
    (action: SettingsTreeAction) => {
      // Button clicks arrive as perform-node-action — handle BEFORE any non-update bail.
      if (action.action === "perform-node-action") {
        if (action.payload.id === "chooseSaveFolder") {
          void (async () => {
            try {
              const handle = await (
                window as unknown as {
                  showDirectoryPicker: () => Promise<FileSystemDirectoryHandle>;
                }
              ).showDirectoryPicker();
              dirHandleRef.current = handle;
              setSaveFolderName(handle.name);
            } catch {
              // user cancelled the picker — leave the existing handle in place
            }
          })();
        }
        return;
      }
      if (action.action !== "update") {
        return; // ignore reorder-children / unknown actions (no throwing default)
      }
      const next = applyAction(configRef.current, action);
      if (next === configRef.current) {
        return; // unchanged
      }
      setConfig(next);
      context.saveState(next);
    },
    [context],
  );

  // (Re)render the settings editor on mount and whenever inputs change.
  useEffect(() => {
    context.updatePanelSettingsEditor(
      buildSettingsTree(config, topics, actionHandler, { canPickDir, saveFolderName }),
    );
  }, [context, config, topics, saveFolderName, actionHandler]);

  const onSave = useCallback(() => {
    workerRef.current?.postMessage({ type: "save" });
  }, []);

  const onReset = useCallback(() => {
    workerRef.current?.postMessage({ type: "reset" });
    setForwarded(0);
    setStat(ZERO_STAT);
    setLastSaveStatus("");
  }, []);

  const budget = statSummary(stat, config);
  const captureOn = workerReady && enabledTopics.length > 0;
  const saveDestination = saveFolderName ?? "Browser download";

  return (
    <div style={{ padding: "1rem", fontFamily: "sans-serif", lineHeight: 1.5 }}>
      <h2 style={{ margin: "0 0 0.5rem" }}>DIY DVR</h2>
      <p style={{ margin: "0 0 1rem", opacity: 0.7 }}>
        Forwards enabled-topic messages to a Web Worker, which buffers them in a bounded ring and
        encodes them to MCAP. Save dumps the buffer; auto-save rotates a full window to a file.
      </p>

      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <button onClick={onSave} disabled={!workerReady} style={{ padding: "0.5rem 1rem" }}>
          Save MCAP
        </button>
        <button onClick={onReset} disabled={!workerReady} style={{ padding: "0.5rem 1rem" }}>
          Reset buffer
        </button>
      </div>

      <table style={{ borderSpacing: "0.5rem 0.25rem" }}>
        <tbody>
          <tr>
            <td style={{ opacity: 0.7 }}>Worker</td>
            <td>{workerReady ? "ready" : "starting…"}</td>
          </tr>
          <tr>
            <td style={{ opacity: 0.7 }}>Capture</td>
            <td>{captureOn ? "on" : "off"}</td>
          </tr>
          <tr>
            <td style={{ opacity: 0.7 }}>Topics subscribed</td>
            <td>
              {enabledTopics.length} / {topics.length}
            </td>
          </tr>
          <tr>
            <td style={{ opacity: 0.7 }}>Messages forwarded</td>
            <td>{forwarded}</td>
          </tr>
          <tr>
            <td style={{ opacity: 0.7 }}>Budget used</td>
            <td>
              {budget.used} / {budget.cap}
            </td>
          </tr>
          <tr>
            <td style={{ opacity: 0.7 }}>Rotations</td>
            <td>{stat.rotations}</td>
          </tr>
          <tr>
            <td style={{ opacity: 0.7 }}>Buffered in worker</td>
            <td>
              {stat.bufferedMsgs} msgs / {stat.channels} channels
            </td>
          </tr>
          <tr>
            <td style={{ opacity: 0.7 }}>Save destination</td>
            <td>{saveDestination}</td>
          </tr>
          <tr>
            <td style={{ opacity: 0.7 }}>Last save</td>
            <td>{lastSaveStatus.length > 0 ? lastSaveStatus : "—"}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function initDvrPanel(context: PanelExtensionContext): () => void {
  const root = createRoot(context.panelElement);
  root.render(<DvrPanel context={context} />);
  return () => {
    root.unmount();
  };
}

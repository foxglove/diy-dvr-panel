import { PanelExtensionContext, SettingsTreeAction, Topic } from "@foxglove/extension";
import * as React from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { clearDirHandle, loadDirHandle, saveDirHandle } from "./fsStore";
import { MCAP_WORKER_SOURCE } from "./generatedWorkerSource";
import { applyAction, buildSettingsTree, DEFAULT_CONFIG, DvrConfig } from "./settings";

// Extensions render plain React with no access to the app's MUI theme, so we drive
// body colors from the watched color scheme with a small inline-style palette.
type ColorScheme = "light" | "dark";

type Theme = {
  fg: string;
  muted: string;
  border: string;
  buttonBg: string;
  buttonHoverBg: string;
  accentBg: string;
  accentHoverBg: string;
  accentFg: string;
  accentText: string;
};

function makeTheme(scheme: ColorScheme): Theme {
  if (scheme === "light") {
    return {
      fg: "#1f2329",
      muted: "#6b7280",
      border: "rgba(0, 0, 0, 0.15)",
      buttonBg: "rgba(0, 0, 0, 0.05)",
      buttonHoverBg: "rgba(0, 0, 0, 0.1)",
      accentBg: "#1f6feb",
      accentHoverBg: "#1a5fd0",
      accentFg: "#ffffff",
      accentText: "#1f6feb",
    };
  }
  return {
    fg: "#e6e6ea",
    muted: "#9a9aa2",
    border: "rgba(255, 255, 255, 0.16)",
    buttonBg: "rgba(255, 255, 255, 0.09)",
    buttonHoverBg: "rgba(255, 255, 255, 0.16)",
    accentBg: "#4b8bff",
    accentHoverBg: "#3d78e8",
    accentFg: "#ffffff",
    accentText: "#7db0ff",
  };
}

type ButtonVariant = "primary" | "default" | "link";

type ButtonState = { disabled: boolean; hover: boolean };

function pickBg(state: ButtonState, base: string, hoverBg: string): string {
  if (state.disabled) {
    return base;
  }
  if (state.hover) {
    return hoverBg;
  }
  return base;
}

function buttonStyle(
  theme: Theme,
  variant: ButtonVariant,
  state: ButtonState,
): React.CSSProperties {
  const { disabled, hover } = state;
  const base: React.CSSProperties = {
    font: "inherit",
    fontSize: "0.8125rem",
    fontWeight: 500,
    lineHeight: 1.2,
    borderRadius: 4,
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.5 : 1,
    transition: "background 0.15s ease, color 0.15s ease",
  };
  if (variant === "link") {
    return {
      ...base,
      padding: "0.1rem 0.2rem",
      color: theme.accentText,
      background: "transparent",
      border: "none",
      textDecoration: hover && !disabled ? "underline" : "none",
    };
  }
  if (variant === "primary") {
    return {
      ...base,
      padding: "0.45rem 0.9rem",
      color: theme.accentFg,
      background: pickBg(state, theme.accentBg, theme.accentHoverBg),
      border: "1px solid transparent",
    };
  }
  return {
    ...base,
    padding: "0.45rem 0.9rem",
    color: theme.fg,
    background: pickBg(state, theme.buttonBg, theme.buttonHoverBg),
    border: `1px solid ${theme.border}`,
  };
}

function ThemedButton({
  theme,
  variant = "default",
  disabled = false,
  onClick,
  children,
}: {
  theme: Theme;
  variant?: ButtonVariant;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={buttonStyle(theme, variant, { disabled, hover })}
      onMouseEnter={() => {
        setHover(true);
      }}
      onMouseLeave={() => {
        setHover(false);
      }}
    >
      {children}
    </button>
  );
}

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
    // Floor at zero so a transient backward time jump can never render negative.
    const usedSec = stat.bufferedMsgs > 0 ? Math.max(0, Number(spanNanos) / 1e9) : 0;
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
  const [colorScheme, setColorScheme] = useState<ColorScheme>("dark");

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

  // Restore a previously-picked save folder on mount. The handle persists in
  // IndexedDB across remounts/reloads; we only restore it here (no requestPermission
  // without a user gesture) — permission is re-verified lazily at save time.
  useEffect(() => {
    if (!canPickDir) {
      return;
    }
    const active = { current: true };
    void (async () => {
      try {
        const handle = await loadDirHandle();
        if (active.current && handle != undefined) {
          dirHandleRef.current = handle;
          setSaveFolderName(handle.name);
        }
      } catch (err) {
        console.error("[diy-dvr] failed to load saved folder", err);
      }
    })();
    return () => {
      active.current = false;
    };
  }, []);

  // Open the directory picker (shared by the sidebar action and the in-body button)
  // and persist the chosen handle to IndexedDB so it survives remounts/reloads.
  const chooseSaveFolder = useCallback(() => {
    void (async () => {
      try {
        const handle = await (
          window as unknown as {
            showDirectoryPicker: () => Promise<FileSystemDirectoryHandle>;
          }
        ).showDirectoryPicker();
        // Request write permission NOW, inside the user gesture — later saves (and
        // auto-save rotations) have no gesture, so requestPermission would fail there
        // and fall back to the native download dialog.
        const granted = await ensureRwPermission(handle);
        if (!granted) {
          setLastSaveStatus("Folder not granted write permission — using browser download");
          return; // leave the previous handle / browser-download in place
        }
        dirHandleRef.current = handle;
        setSaveFolderName(handle.name);
        try {
          await saveDirHandle(handle);
        } catch (err) {
          console.error("[diy-dvr] failed to persist save folder", err);
        }
      } catch {
        // user cancelled the picker — leave the existing handle in place
      }
    })();
  }, []);

  // Revert to browser-download saves and forget the stored folder.
  const useBrowserDownload = useCallback(() => {
    dirHandleRef.current = undefined;
    setSaveFolderName(undefined);
    void clearDirHandle().catch((err: unknown) => {
      console.error("[diy-dvr] failed to clear saved folder", err);
    });
  }, []);

  // Forward every message from every subscribed topic to the worker.
  useLayoutEffect(() => {
    context.onRender = (renderState, done) => {
      if (renderState.topics) {
        setTopics(renderState.topics);
      }
      if (renderState.colorScheme) {
        setColorScheme(renderState.colorScheme);
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
    context.watch("colorScheme");
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
    // Auto-save is only effective when a save folder is set; otherwise every rotation
    // would dump to the native download dialog. Never send autoSave:true without a
    // folder so a stale persisted flag can't trigger download-dialog rotations.
    const autoSaveEffective = config.autoSave && saveFolderName != undefined;
    worker.postMessage({
      type: "config",
      budgetMode: config.budgetMode,
      budgetNanos:
        config.budgetMode === "time" ? BigInt(Math.round(config.budgetValue * 1e9)) : undefined,
      budgetBytes:
        config.budgetMode === "bytes" ? Math.round(config.budgetValue * 1024 * 1024) : undefined,
      autoSave: autoSaveEffective,
      enabledTopics: enabledTopics.map((topic) => topic.name),
    });
  }, [config, enabledTopics, workerReady, saveFolderName]);

  // Stable settings-editor action handler (reads latest config/topics via refs).
  const actionHandler = useCallback(
    (action: SettingsTreeAction) => {
      // Button clicks arrive as perform-node-action — handle BEFORE any non-update bail.
      if (action.action === "perform-node-action") {
        if (action.payload.id === "chooseSaveFolder") {
          chooseSaveFolder();
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
    [context, chooseSaveFolder],
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
  const theme = makeTheme(colorScheme);

  const statRows: Array<{ label: string; value: React.ReactNode }> = [
    { label: "Worker", value: workerReady ? "Ready" : "Starting…" },
    { label: "Capture", value: captureOn ? "On" : "Off" },
    { label: "Topics subscribed", value: `${enabledTopics.length} / ${topics.length}` },
    { label: "Messages forwarded", value: forwarded },
    { label: "Budget used", value: `${budget.used} / ${budget.cap}` },
    { label: "Rotations", value: stat.rotations },
    { label: "Buffered", value: `${stat.bufferedMsgs} msgs / ${stat.channels} channels` },
    { label: "Save destination", value: saveDestination },
    { label: "Last save", value: lastSaveStatus.length > 0 ? lastSaveStatus : "—" },
  ];

  return (
    <div
      style={{
        padding: "1rem",
        fontFamily: "inherit",
        fontSize: "0.8125rem",
        lineHeight: 1.5,
        color: theme.fg,
      }}
    >
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.85rem" }}>
        <ThemedButton theme={theme} variant="default" disabled={!workerReady} onClick={onSave}>
          Save MCAP
        </ThemedButton>
        <ThemedButton theme={theme} variant="default" disabled={!workerReady} onClick={onReset}>
          Reset buffer
        </ThemedButton>
      </div>

      {canPickDir && (
        <div style={{ marginBottom: "0.85rem" }}>
          {saveFolderName == undefined ? (
            <ThemedButton theme={theme} variant="primary" onClick={chooseSaveFolder}>
              Choose save folder…
            </ThemedButton>
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.4rem",
                flexWrap: "wrap",
              }}
            >
              <span style={{ color: theme.muted }}>Saving to</span>
              <span style={{ color: theme.fg, fontWeight: 600, wordBreak: "break-all" }}>
                {saveFolderName}
              </span>
              <ThemedButton theme={theme} variant="link" onClick={chooseSaveFolder}>
                Change…
              </ThemedButton>
              <ThemedButton theme={theme} variant="link" onClick={useBrowserDownload}>
                Use browser download
              </ThemedButton>
            </div>
          )}
        </div>
      )}

      <div style={{ display: "grid", rowGap: "0.15rem", marginBottom: "0.85rem" }}>
        {statRows.map((row) => (
          <div
            key={row.label}
            style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}
          >
            <span style={{ color: theme.muted }}>{row.label}</span>
            <span style={{ color: theme.fg, textAlign: "right", wordBreak: "break-word" }}>
              {row.value}
            </span>
          </div>
        ))}
      </div>

      <p style={{ margin: 0, color: theme.muted, fontSize: "0.75rem" }}>
        Topics, budget, and auto-save are in panel Settings (gear icon).
      </p>
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

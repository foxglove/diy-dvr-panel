import { PanelExtensionContext, SettingsTreeAction, Topic } from "@foxglove/extension";
import * as React from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { ClipMeta, planEviction } from "./clipTypes";
import { MCAP_WORKER_SOURCE } from "./generatedWorkerSource";
import { SaveResult, SaveStatus, statusFromResult } from "./saveStatus";
import { applyAction, BudgetMode, buildSettingsTree, DEFAULT_CONFIG, DvrConfig } from "./settings";

// Extensions render plain React with no access to the app's MUI theme, so we drive
// body colors from the watched color scheme with a small inline-style palette.
type ColorScheme = "light" | "dark";

type Theme = {
  /**
   * Opaque panel background. Required by the sticky header: a translucent background
   * would let scrolled content show through it.
   */
  bg: string;
  fg: string;
  muted: string;
  border: string;
  buttonBg: string;
  buttonHoverBg: string;
  accentBg: string;
  accentHoverBg: string;
  accentFg: string;
  accentText: string;
  /** Capture-active indicator, and the "plenty of room" end of the cache meter. */
  success: string;
  /** Cache meter approaching the cap. */
  warn: string;
  /** Destructive actions, and a full cache. */
  danger: string;
  dangerBorder: string;
  dangerHoverBg: string;
};

// Contrast against the scheme's own `bg`, measured: every color below is at least
// 4.5:1 (WCAG AA for normal text) in both light and dark.
//   light  fg 15.78  muted 4.83  accentText 4.63  success 5.08  warn 4.87  danger 6.54
//   dark   fg 13.69  muted 6.10  accentText 7.73  success 6.71  warn 6.75  danger 5.97
function makeTheme(scheme: ColorScheme): Theme {
  if (scheme === "light") {
    return {
      bg: "#ffffff",
      fg: "#1f2329",
      muted: "#6b7280",
      border: "rgba(0, 0, 0, 0.15)",
      buttonBg: "rgba(0, 0, 0, 0.05)",
      buttonHoverBg: "rgba(0, 0, 0, 0.1)",
      accentBg: "#1f6feb",
      accentHoverBg: "#1a5fd0",
      accentFg: "#ffffff",
      accentText: "#1f6feb",
      success: "#1a7f37",
      warn: "#9a6700",
      danger: "#b3261e",
      dangerBorder: "rgba(179, 38, 30, 0.5)",
      dangerHoverBg: "rgba(179, 38, 30, 0.08)",
    };
  }
  return {
    bg: "#1a1c21",
    fg: "#e6e6ea",
    muted: "#9a9aa2",
    border: "rgba(255, 255, 255, 0.16)",
    buttonBg: "rgba(255, 255, 255, 0.09)",
    buttonHoverBg: "rgba(255, 255, 255, 0.16)",
    accentBg: "#4b8bff",
    accentHoverBg: "#3d78e8",
    accentFg: "#ffffff",
    accentText: "#7db0ff",
    success: "#3fb950",
    warn: "#d29922",
    danger: "#f47067",
    dangerBorder: "rgba(244, 112, 103, 0.5)",
    dangerHoverBg: "rgba(244, 112, 103, 0.12)",
  };
}

/** Which destructive action is waiting on an inline "are you sure?" confirmation. */
type ConfirmTarget =
  | { kind: "clip"; id: string }
  | { kind: "all" }
  | { kind: "reset" }
  /** A settled cache limit that cannot be applied without dropping cached clips. */
  | { kind: "cacheLimit"; maxCacheMb: number; dropCount: number; dropBytes: number };

/**
 * The settings editor's number fields report every keystroke, so typing `2048` arrives as 2,
 * then 20, then 204. Each of those would reconfigure capture: a 2 MB cache limit evicts
 * almost everything, and a 2 second lookback throws away the buffer. Numbers therefore only
 * reach the worker once the field has been quiet for this long.
 */
const SETTLE_DELAY_MS = 500;

/** The numeric settings, held separately from `config` until they settle. */
type SettledNumbers = {
  budgetValue: number;
  maxCacheMb: number;
  gapThresholdSec: number;
};

function numbersOf(config: DvrConfig): SettledNumbers {
  return {
    budgetValue: config.budgetValue,
    maxCacheMb: config.maxCacheMb,
    gapThresholdSec: config.gapThresholdSec,
  };
}

function sameNumbers(a: SettledNumbers, b: SettledNumbers): boolean {
  return (
    a.budgetValue === b.budgetValue &&
    a.maxCacheMb === b.maxCacheMb &&
    a.gapThresholdSec === b.gapThresholdSec
  );
}

function mbToBytes(mb: number): number {
  return Math.round(mb * 1024 * 1024);
}

/** Controls that stay disabled while the worker is busy on their behalf. */
const BUSY_CACHE_CLIP = "cache-clip";
const BUSY_SAVE_ALL = "save-all";
function busySaveClip(id: string): string {
  return `save-clip:${id}`;
}

/**
 * Longest a control stays disabled without hearing back. Framing and writing a ~1 GB window
 * legitimately takes many seconds, so this is generous — it exists only so a stalled write or
 * a lost reply cannot disable a button for the rest of the session.
 */
const BUSY_TIMEOUT_MS = 60_000;

/**
 * Run `work` once the browser has painted.
 *
 * The heavy framing happens in the worker, so the main thread is free — but the click handler
 * still has to let React commit and paint the disabled state before posting, otherwise the
 * message goes out in the same task and the user sees an unchanged, enabled button while
 * several seconds of work happen. A `requestAnimationFrame` callback runs *before* the repaint,
 * so the nested timeout is what lands after it.
 */
function afterPaint(work: () => void): void {
  if (typeof requestAnimationFrame !== "function") {
    setTimeout(work, 0);
    return;
  }
  requestAnimationFrame(() => {
    setTimeout(work, 0);
  });
}

/** The buffer controls fill the panel, but stop before they look stretched. */
const CONTROL_ROW_MAX_WIDTH = 400;

type ButtonVariant = "primary" | "default" | "danger" | "link";

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
    borderRadius: 0,
    // Buttons carry an inline icon plus a label; keep them on one baseline.
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.35rem",
    // Panels can be narrow; let a button row wrap rather than breaking a label
    // across lines ("Save / to / disk").
    whiteSpace: "nowrap",
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
  if (variant === "danger") {
    // Understated on purpose: a red outline reads as destructive without shouting
    // like a solid fill would, which matches the restrained look of the app.
    return {
      ...base,
      padding: "0.45rem 0.9rem",
      color: theme.danger,
      background: pickBg(state, "transparent", theme.dangerHoverBg),
      border: `1px solid ${theme.dangerBorder}`,
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
  title,
  style,
  onClick,
  children,
}: {
  theme: Theme;
  variant?: ButtonVariant;
  disabled?: boolean;
  /** Tooltip / accessible name, for the controls whose label is just a glyph. */
  title?: string;
  /** Merged over the variant style, for per-call layout tweaks (flex sizing, hit area). */
  style?: React.CSSProperties;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      style={{ ...buttonStyle(theme, variant, { disabled, hover }), ...style }}
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

// Inline SVGs rather than an icon dependency: they inherit `currentColor` and the
// button's font size, so they stay correct in both color schemes automatically.
const ICON_PROPS = {
  width: "1em",
  height: "1em",
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  focusable: false,
  style: { flex: "0 0 auto" },
} as const;

/** Download / save-to-disk. */
function SaveIcon(): React.JSX.Element {
  return (
    <svg {...ICON_PROPS}>
      <path d="M8 2v7.5" />
      <path d="M5 7l3 3 3-3" />
      <path d="M2.5 11.5v1a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5v-1" />
    </svg>
  );
}

/** Snapshot / bookmark, for stashing a clip in the cache. */
function ClipIcon(): React.JSX.Element {
  return (
    <svg {...ICON_PROPS}>
      <path d="M4 2h8a.5.5 0 0 1 .5.5v11l-4.5-3-4.5 3v-11A.5.5 0 0 1 4 2Z" />
    </svg>
  );
}

/** Trash, for discarding the live buffer. */
function TrashIcon(): React.JSX.Element {
  return (
    <svg {...ICON_PROPS}>
      <path d="M2.5 4.5h11" />
      <path d="M6.5 2.5h3" />
      <path d="M4 4.5l.6 8.2a1 1 0 0 0 1 .8h4.8a1 1 0 0 0 1-.8l.6-8.2" />
      <path d="M6.5 7v4M9.5 7v4" />
    </svg>
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

/**
 * The chosen save folder, held for the life of the *page* instead of being persisted.
 *
 * Chromium grants a directory's read-write permission for the current session only and
 * drops it back to "prompt" on the next page load. A handle restored from storage would
 * therefore present a folder as the active destination while every save to it silently
 * paused — the same lapsed grant behind the auto-save data loss. Module scope has exactly
 * the right lifetime: it survives the panel remount the app performs on a reconnect (where
 * the grant is still live, so the folder should be kept) and is empty again after a reload,
 * so every page load starts at "Browser download" until the user picks a folder. Picking it
 * is the gesture that re-grants access for the session.
 *
 * Shared by every DIY DVR panel in the page, which is how the folder already behaved.
 */
let sessionDirHandle: FileSystemDirectoryHandle | undefined;

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

/** Whether the durable clip cache is usable, and which OPFS path the worker is using. */
type CacheStatus = { available: boolean; mode: string };

const UNKNOWN_CACHE: CacheStatus = { available: true, mode: "unknown" };

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
  /** The full cached-clip list, re-broadcast after every create / evict / delete / clear. */
  | { type: "clips"; clips: ClipMeta[]; cache?: CacheStatus }
  /** One cached clip's bytes, in response to a requestClipBytes. */
  | { type: "clipBytes"; id: string; meta: ClipMeta; buffer: ArrayBuffer }
  | { type: "error"; message: string };

function defaultMcapName(): string {
  return `diy-dvr-${Date.now()}.mcap`;
}

/**
 * Filename for a cached clip. Derived from the clip rather than the wall clock because
 * "Save all" writes every clip in one loop, and `Date.now()` would give several of them
 * the same name and silently overwrite files.
 */
function clipFileName(meta: ClipMeta): string {
  const trigger = meta.trigger.replace(/[^A-Za-z0-9._-]/g, "-");
  return `diy-dvr-${trigger}-${meta.createdAt}.mcap`;
}

/** Blob + anchor download — the fallback when silent directory write is unavailable. */
function downloadMcap(buffer: ArrayBuffer, name: string = defaultMcapName()): string {
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
  name: string = defaultMcapName(),
): Promise<string> {
  const fileHandle = await dirHandle.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(buffer);
  await writable.close();
  return name;
}

// Chromium only grants requestPermission({mode:"readwrite"}) under transient
// activation (a live user gesture), and it does not durably keep the grant:
// IndexedDB-restored handles start at "prompt", and live grants lapse on
// reload/focus-loss/inactivity. So permission is only ever *requested* from a real
// gesture (button/toggle/settings action) via requestRwPermission; the async
// worker "saved" callback — which has no gesture — only ever *queries* via
// hasRwPermission. Requesting from the gesture-less callback would silently fail
// and surprise the user with the native Save dialog.

/** Query-only read-write permission check. Safe to call in any context (no gesture needed). */
async function hasRwPermission(dirHandle: FileSystemDirectoryHandle): Promise<boolean> {
  const handle = dirHandle as unknown as FileSystemHandlePermissions;
  if (handle.queryPermission == undefined) {
    return true; // permission API absent — attempt the write and let it throw if denied
  }
  const perm = await handle.queryPermission({ mode: "readwrite" });
  return perm === "granted";
}

/**
 * Query, then request read-write permission if not already granted. MUST be called
 * from within a live user gesture (button onClick / settings action / toggle);
 * requestPermission fails silently without transient activation.
 */
async function requestRwPermission(dirHandle: FileSystemDirectoryHandle): Promise<boolean> {
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

/**
 * Decide where the freshly-sealed MCAP goes and perform the write/download.
 * Query-only on permission (safe in the gesture-less "saved" callback) — a lapsed
 * grant on a rotation pauses instead of surprising the user with the native dialog.
 */
async function persistCapture(
  buffer: ArrayBuffer,
  dirHandle: FileSystemDirectoryHandle | undefined,
  trigger: "manual" | "rotation",
  fileName: string = defaultMcapName(),
): Promise<SaveResult> {
  if (!canPickDir || dirHandle == undefined) {
    return { mode: "download", name: downloadMcap(buffer, fileName) };
  }
  try {
    if (await hasRwPermission(dirHandle)) {
      const name = await writeMcapFile(buffer, dirHandle, fileName);
      return { mode: "folder", name, folder: dirHandle.name };
    }
    // Grant lapsed. Never request (no gesture). Rotations pause; manual saves download.
    if (trigger === "rotation") {
      return { mode: "paused" };
    }
    return { mode: "download", name: downloadMcap(buffer, fileName), reason: "denied" };
  } catch (err) {
    return {
      mode: "download",
      name: downloadMcap(buffer, fileName),
      reason: "error",
      error: String(err),
    };
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }
  return `${(kb / 1024).toFixed(1)} MB`;
}

function formatDurationSec(seconds: number): string {
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

/**
 * Clock label for a clip row. Uses the capture wall-clock time rather than the clip's
 * `startNanos`, because the latter comes from the source's own clock and is zero for a
 * source that publishes no time.
 */
function formatClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString();
}

/** Short description of where cached clips live, shown next to the clips heading. */
function cacheModeLabel(cache: CacheStatus): string {
  if (!cache.available) {
    return "browser storage unavailable";
  }
  switch (cache.mode) {
    case "sync":
      return "OPFS (sync)";
    case "async":
      return "OPFS (async)";
    case "unavailable":
      return "browser storage unavailable";
    default:
      return "OPFS";
  }
}

/**
 * Cache fullness, green through amber to red. Eviction silently drops the oldest whole
 * clip at the cap, so "getting full" is worth showing before it bites.
 */
function meterColor(theme: Theme, ratio: number): string {
  if (ratio >= 0.9) {
    return theme.danger;
  }
  if (ratio >= 0.7) {
    return theme.warn;
  }
  return theme.success;
}

function CacheMeter({
  theme,
  usedBytes,
  capBytes,
}: {
  theme: Theme;
  usedBytes: number;
  capBytes: number;
}): React.JSX.Element | null {
  if (capBytes <= 0) {
    return null;
  }
  const ratio = Math.min(1, Math.max(0, usedBytes / capBytes));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(ratio * 100)}
      aria-label="Clip cache used"
      style={{
        height: "0.25rem",
        margin: "0 0 0.5rem",
        background: theme.border,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: `${(ratio * 100).toFixed(1)}%`,
          // A large cap makes early usage round to a hair; keep it visible so the meter
          // reads as "a little used" rather than as an empty or broken bar.
          minWidth: usedBytes > 0 ? "2px" : 0,
          height: "100%",
          background: meterColor(theme, ratio),
          transition: "width 0.3s ease, background 0.3s ease",
        }}
      />
    </div>
  );
}

/**
 * A `recovered` clip came from an interrupted session, so it is often longer and less
 * expected than a clean gap clip — worth telling apart at a glance.
 */
function chipColors(theme: Theme, trigger: ClipMeta["trigger"]): React.CSSProperties {
  if (trigger === "recovered") {
    return { color: theme.warn, borderColor: theme.warn };
  }
  if (trigger === "manual-clip") {
    return { color: theme.accentText, borderColor: theme.accentText };
  }
  return { color: theme.muted, borderColor: theme.border };
}

function TriggerChip({ theme, clip }: { theme: Theme; clip: ClipMeta }): React.JSX.Element {
  return (
    <span
      style={{
        ...chipColors(theme, clip.trigger),
        borderStyle: "solid",
        borderWidth: 1,
        padding: "0.05rem 0.3rem",
        fontSize: "0.6875rem",
        fontWeight: 600,
        letterSpacing: "0.02em",
        whiteSpace: "nowrap",
      }}
    >
      {clip.triggerLabel}
    </span>
  );
}

function sectionTitleStyle(theme: Theme): React.CSSProperties {
  return {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    gap: "0.15rem 0.5rem",
    margin: "0 0 0.4rem",
    paddingBottom: "0.25rem",
    borderBottom: `1px solid ${theme.border}`,
    fontSize: "0.6875rem",
    fontWeight: 600,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    color: theme.muted,
  };
}

/** Outlined notice inside the pinned zone, for things the user must not scroll past. */
function Banner({
  color,
  role,
  children,
}: {
  color: string;
  role?: "alert";
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      role={role}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: "0.4rem",
        marginTop: "0.4rem",
        padding: "0.3rem 0.4rem",
        border: `1px solid ${color}`,
        color,
        fontSize: "0.75rem",
        lineHeight: 1.35,
      }}
    >
      {children}
    </div>
  );
}

type ClipRowProps = {
  theme: Theme;
  clip: ClipMeta;
  expanded: boolean;
  confirmingDelete: boolean;
  /** This clip's bytes are being read back and written; reading ~1 GB is not instant. */
  saving: boolean;
  onToggleExpand: () => void;
  onSave: () => void;
  onAskDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
};

/** One cached clip: a summary line, expandable into its per-topic message counts. */
function ClipRow({
  theme,
  clip,
  expanded,
  confirmingDelete,
  saving,
  onToggleExpand,
  onSave,
  onAskDelete,
  onConfirmDelete,
  onCancelDelete,
}: ClipRowProps): React.JSX.Element {
  const topicCounts = Object.entries(clip.topicCounts).sort((a, b) => a[0].localeCompare(b[0]));
  // Two lines rather than one wide row: a panel is often only a few hundred pixels wide,
  // and five columns plus two controls on one line squeezes every label.
  return (
    <div style={{ borderTop: `1px solid ${theme.border}`, padding: "0.35rem 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
        <ThemedButton
          theme={theme}
          variant="link"
          title={expanded ? "Hide topics" : "Show topics"}
          onClick={onToggleExpand}
        >
          {expanded ? "▾" : "▸"}
        </ThemedButton>
        <TriggerChip theme={theme} clip={clip} />
        <span style={{ flex: "1 1 auto" }} />
        {confirmingDelete ? (
          <>
            <span style={{ color: theme.muted }}>Delete?</span>
            <ThemedButton theme={theme} variant="link" onClick={onConfirmDelete}>
              Yes
            </ThemedButton>
            <ThemedButton theme={theme} variant="link" onClick={onCancelDelete}>
              No
            </ThemedButton>
          </>
        ) : (
          <>
            <ThemedButton
              theme={theme}
              variant="link"
              disabled={clip.messageCount === 0 || saving}
              onClick={onSave}
            >
              {saving ? "Saving…" : "Save to disk"}
            </ThemedButton>
            {/* Bigger hit area and a clear gap from Save, so the destructive
                control is harder to catch by accident. */}
            <ThemedButton
              theme={theme}
              variant="link"
              title="Delete clip"
              style={{ padding: "0.25rem 0.4rem", marginLeft: "0.5rem" }}
              onClick={onAskDelete}
            >
              ✕
            </ThemedButton>
          </>
        )}
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          columnGap: "0.75rem",
          margin: "0 0 0 1.5rem",
          color: theme.muted,
          fontSize: "0.75rem",
        }}
      >
        <span>{formatClock(clip.createdAt)}</span>
        <span>{formatDurationSec(clip.durationSec)}</span>
        <span>{formatBytes(clip.byteSize)}</span>
        <span>{clip.messageCount} msgs</span>
      </div>
      {expanded && (
        <div
          style={{
            display: "grid",
            rowGap: "0.1rem",
            margin: "0.3rem 0 0.35rem 1.5rem",
            fontSize: "0.75rem",
          }}
        >
          {topicCounts.length === 0 ? (
            <span style={{ color: theme.muted }}>No topics recorded.</span>
          ) : (
            topicCounts.map(([topic, count]) => (
              <div
                key={topic}
                style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem" }}
              >
                <span style={{ color: theme.muted, wordBreak: "break-all" }}>{topic}</span>
                <span>{count}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The pinned one-liner. Being subscribed to topics is not the same as receiving data, so
 * this does not claim to be recording until something is actually buffered — the headline
 * state has to be honest about a source that is connected but silent.
 */
function bufferStatus(
  stat: WorkerStat,
  flags: { workerReady: boolean; enabledTopics: number },
): { label: string; active: boolean } {
  if (!flags.workerReady) {
    return { label: "Starting…", active: false };
  }
  if (flags.enabledTopics === 0) {
    return { label: "No topics selected", active: false };
  }
  if (stat.bufferedMsgs === 0) {
    return { label: "Waiting for data", active: false };
  }
  return { label: "Recording", active: true };
}

/** `budget` is the lookback actually in force — the settled value, not a half-typed one. */
function statSummary(
  stat: WorkerStat,
  budget: { mode: BudgetMode; value: number },
): { used: string; cap: string } {
  if (budget.mode === "time") {
    const spanNanos = BigInt(stat.newestNanos) - BigInt(stat.oldestNanos);
    // Floor at zero so a transient backward time jump can never render negative.
    const usedSec = stat.bufferedMsgs > 0 ? Math.max(0, Number(spanNanos) / 1e9) : 0;
    return { used: `${usedSec.toFixed(1)}s`, cap: `${budget.value}s` };
  }
  const usedMb = stat.byteTotal / (1024 * 1024);
  return { used: `${usedMb.toFixed(2)} MB`, cap: `${budget.value} MB` };
}

function DvrPanel({ context }: { context: PanelExtensionContext }): React.JSX.Element {
  const [topics, setTopics] = useState<readonly Topic[]>([]);
  const [forwarded, setForwarded] = useState(0);
  const [stat, setStat] = useState<WorkerStat>(ZERO_STAT);
  const [workerReady, setWorkerReady] = useState(false);
  const [config, setConfig] = useState<DvrConfig>(() => ({
    ...DEFAULT_CONFIG,
    ...(context.initialState as Partial<DvrConfig> | undefined),
    // Auto-save is a per-session opt-in and never restored, however it was persisted.
    // Chromium drops a directory's read-write grant back to "prompt" across a page load,
    // and rotations have no user gesture, so they can only query the grant — a restored
    // "on" would silently pause every rotation. Turning it on is a gesture, which is
    // exactly when the grant can be re-requested.
    autoSave: false,
  }));
  const [saveFolderName, setSaveFolderName] = useState<string | undefined>(undefined);
  const [lastSave, setLastSave] = useState<SaveStatus | undefined>(undefined);
  const [colorScheme, setColorScheme] = useState<ColorScheme>("dark");
  // Durable clips, oldest first, as broadcast by the worker (the single OPFS owner).
  // `undefined` means the worker has not reported yet: an empty array renders as
  // "confirmed empty", so a slow or failed rehydrate would otherwise look like data loss.
  const [clips, setClips] = useState<ClipMeta[] | undefined>(undefined);
  const [cache, setCache] = useState<CacheStatus>(UNKNOWN_CACHE);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [confirming, setConfirming] = useState<ConfirmTarget | undefined>(undefined);
  // Controls waiting on the worker. Keyed rather than a single flag so a clip row can show
  // its own progress without disabling the others.
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  // The numeric settings currently in force (see SETTLE_DELAY_MS).
  const [settled, setSettled] = useState<SettledNumbers>(() =>
    numbersOf({
      ...DEFAULT_CONFIG,
      ...(context.initialState as Partial<DvrConfig> | undefined),
    }),
  );
  // Collapsed by default: the pinned status line already carries the state that matters,
  // and a panel sharing a layout with others is usually short.
  const [showDetails, setShowDetails] = useState(false);

  const workerRef = useRef<Worker | undefined>(undefined);
  const dirHandleRef = useRef<FileSystemDirectoryHandle | undefined>(undefined);
  // Serializes clip writes: "Save all" fans out N requests and the replies arrive
  // independently, so chain them rather than letting the writes interleave.
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());

  // Refs mirror the latest config/topics so the (stable) settings action handler
  // never goes stale without being recreated on every render.
  const configRef = useRef(config);
  configRef.current = config;
  const topicsRef = useRef(topics);
  topicsRef.current = topics;
  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  const settledRef = useRef(settled);
  settledRef.current = settled;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  /** Safety timers per busy key (see BUSY_TIMEOUT_MS). */
  const busyTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /** Clip ids known when "Cache clip" was dispatched, so its reply can be recognised. */
  const clipsBeforeCacheRef = useRef<ReadonlySet<string> | undefined>(undefined);
  /** Outstanding per-clip saves left in a "Save all" run. */
  const saveAllRemainingRef = useRef(0);

  const endBusy = useCallback((key: string) => {
    const timer = busyTimersRef.current.get(key);
    if (timer != undefined) {
      clearTimeout(timer);
      busyTimersRef.current.delete(key);
    }
    setBusy((previous) => {
      if (!previous.has(key)) {
        return previous; // same reference, no re-render
      }
      const next = new Set(previous);
      next.delete(key);
      return next;
    });
  }, []);

  const beginBusy = useCallback(
    (key: string) => {
      const existing = busyTimersRef.current.get(key);
      if (existing != undefined) {
        clearTimeout(existing);
      }
      busyTimersRef.current.set(
        key,
        setTimeout(() => {
          endBusy(key);
        }, BUSY_TIMEOUT_MS),
      );
      setBusy((previous) => new Set(previous).add(key));
    },
    [endBusy],
  );

  const clearAllBusy = useCallback(() => {
    for (const timer of busyTimersRef.current.values()) {
      clearTimeout(timer);
    }
    busyTimersRef.current.clear();
    saveAllRemainingRef.current = 0;
    clipsBeforeCacheRef.current = undefined;
    setBusy((previous) => (previous.size === 0 ? previous : new Set()));
  }, []);

  // Reached from the worker's message handler, which is installed once and must not depend on
  // anything that changes (re-running that effect would restart the worker).
  const busyControlRef = useRef({ end: endBusy, clearAll: clearAllBusy });
  busyControlRef.current = { end: endBusy, clearAll: clearAllBusy };

  useEffect(() => {
    const timers = busyTimersRef.current;
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

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
          // Auto-save rotations have no user gesture, so permission is query-only
          // here. Manual saves pre-acquire the grant inside the Save click gesture
          // (see onSave), so by the time this callback runs the query succeeds.
          const trigger = data.rotation === true ? "rotation" : "manual";
          void persistCapture(buffer, dirHandle, trigger).then((result) => {
            setLastSave(statusFromResult(result));
          });
          break;
        }
        case "clips": {
          setClips(data.clips);
          setCache(data.cache ?? UNKNOWN_CACHE);
          // A clip we had not seen before means the "Cache clip" write landed.
          const before = clipsBeforeCacheRef.current;
          if (before != undefined && data.clips.some((clip) => !before.has(clip.id))) {
            clipsBeforeCacheRef.current = undefined;
            busyControlRef.current.end(BUSY_CACHE_CLIP);
          }
          break;
        }
        case "clipBytes": {
          // Queue behind any in-flight clip write so "Save all" writes one file at a time.
          const { buffer, meta } = data;
          saveChainRef.current = saveChainRef.current
            .then(async () => {
              const result = await persistCapture(
                buffer,
                dirHandleRef.current,
                "manual",
                clipFileName(meta),
              );
              setLastSave(statusFromResult(result));
            })
            .catch((err: unknown) => {
              console.error("[diy-dvr] failed to save clip", err);
              setLastSave({ text: `Clip save failed: ${String(err)}`, severity: "error" });
            })
            .finally(() => {
              // This clip is done either way; release its row, and "Save all" once the last
              // clip of the run has been written.
              busyControlRef.current.end(busySaveClip(meta.id));
              saveAllRemainingRef.current = Math.max(0, saveAllRemainingRef.current - 1);
              if (saveAllRemainingRef.current === 0) {
                busyControlRef.current.end(BUSY_SAVE_ALL);
              }
            });
          break;
        }
        case "error":
          console.error("[diy-dvr] worker save failed", data.message);
          setLastSave({ text: data.message, severity: "error" });
          // The message does not say which request failed, so release everything rather than
          // risk leaving a control disabled. Re-enabling early is recoverable; stuck is not.
          busyControlRef.current.clearAll();
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

  // Snapshot the buffer into a durable clip when the panel is about to lose the CPU or go
  // away entirely. Browsers throttle worker timers in background tabs, so the worker's own
  // gap timer cannot be relied on once we are hidden — hence an explicit trigger here.
  // `pagehide` is best effort: the clip build usually cannot finish, which is what the
  // throttled OPFS mirror (promoted to a "recovered" clip on the next mount) is for.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        workerRef.current?.postMessage({ type: "trigger", tag: "backgrounded" });
      }
    };
    const onPageHide = () => {
      workerRef.current?.postMessage({ type: "trigger", tag: "closing" });
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, []);

  // Pick up a folder chosen earlier in this page session (the app remounts the panel on a
  // reconnect, and the grant is still live then). After a reload there is nothing to pick
  // up, so the destination starts at "Browser download" — see `sessionDirHandle`.
  useEffect(() => {
    if (!canPickDir || sessionDirHandle == undefined) {
      return;
    }
    dirHandleRef.current = sessionDirHandle;
    setSaveFolderName(sessionDirHandle.name);
  }, []);

  // Open the directory picker (shared by the sidebar action and the in-body button) and
  // keep the chosen handle for the rest of the page session.
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
        const granted = await requestRwPermission(handle);
        if (!granted) {
          setLastSave({
            text: "Folder not granted write permission — using browser download",
            severity: "warn",
          });
          return; // leave the previous handle / browser-download in place
        }
        dirHandleRef.current = handle;
        sessionDirHandle = handle;
        setSaveFolderName(handle.name);
      } catch {
        // user cancelled the picker — leave the existing handle in place
      }
    })();
  }, []);

  // Revert to browser-download saves and forget the folder. (Not a hook — named without a
  // "use" prefix so it can be called from the settings action.)
  const selectBrowserDownload = useCallback(() => {
    dirHandleRef.current = undefined;
    sessionDirHandle = undefined;
    setSaveFolderName(undefined);
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

  // What the worker is actually configured with. Built from the *settled* numbers, so an
  // in-progress edit never reconfigures capture, and memoized so a keystroke that changes
  // nothing effective does not re-post the config at all.
  const workerConfig = useMemo(() => {
    // Auto-save is only effective when a save folder is set; otherwise every rotation
    // would dump to the native download dialog. Never send autoSave:true without a
    // folder so a stale persisted flag can't trigger download-dialog rotations.
    const autoSaveEffective = config.autoSave && saveFolderName != undefined;
    return {
      type: "config",
      budgetMode: config.budgetMode,
      budgetNanos:
        config.budgetMode === "time" ? BigInt(Math.round(settled.budgetValue * 1e9)) : undefined,
      budgetBytes: config.budgetMode === "bytes" ? mbToBytes(settled.budgetValue) : undefined,
      autoSave: autoSaveEffective,
      enabledTopics: enabledTopics.map((topic) => topic.name),
      maxCacheBytes: mbToBytes(settled.maxCacheMb),
      gapMs: Math.round(settled.gapThresholdSec * 1000),
    };
  }, [config.budgetMode, config.autoSave, settled, enabledTopics, saveFolderName]);

  useEffect(() => {
    workerRef.current?.postMessage(workerConfig);
  }, [workerConfig, workerReady]);

  // Promote edited numbers once the field settles. Lowering the cache limit below what is
  // already cached would evict clips, so that one asks first instead of applying; everything
  // else takes effect straight away.
  useEffect(() => {
    const pending = numbersOf(config);
    if (sameNumbers(pending, settled)) {
      return;
    }
    const timer = setTimeout(() => {
      const doomed = planEviction(clipsRef.current ?? [], mbToBytes(pending.maxCacheMb));
      if (pending.maxCacheMb !== settled.maxCacheMb && doomed.length > 0) {
        // Apply the harmless numbers now and hold the cache limit for confirmation.
        setSettled({ ...pending, maxCacheMb: settled.maxCacheMb });
        setConfirming({
          kind: "cacheLimit",
          maxCacheMb: pending.maxCacheMb,
          dropCount: doomed.length,
          dropBytes: doomed.reduce((total, clip) => total + clip.byteSize, 0),
        });
        return;
      }
      setSettled(pending);
      setConfirming((previous) => (previous?.kind === "cacheLimit" ? undefined : previous));
    }, SETTLE_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [config, settled]);

  /** Apply a held-back cache limit, letting the worker evict down to it. */
  const onApplyCacheLimit = useCallback((maxCacheMb: number) => {
    setSettled((previous) => ({ ...previous, maxCacheMb }));
    setConfirming(undefined);
  }, []);

  /** Abandon a held-back cache limit and put the old number back in the settings editor. */
  const onCancelCacheLimit = useCallback(() => {
    setConfirming(undefined);
    setConfig((previous) => {
      const restored = { ...previous, maxCacheMb: settledRef.current.maxCacheMb };
      context.saveState(restored);
      return restored;
    });
  }, [context]);

  // Stable settings-editor action handler (reads latest config/topics via refs).
  const actionHandler = useCallback(
    (action: SettingsTreeAction) => {
      if (action.action !== "update") {
        return; // ignore node actions / reorder-children / unknown (no throwing default)
      }
      const path = action.payload.path;

      // "Save destination" select. A settings change is a user gesture, so opening
      // the picker / requesting permission from here runs under transient activation.
      if (path[0] === "saving" && path[1] === "saveDestination") {
        const value = action.payload.value;
        if (value === "choose") {
          chooseSaveFolder();
        } else if (value === "download") {
          selectBrowserDownload();
        }
        return; // saveDestination is not persisted config
      }

      // Enabling auto-save is a gesture — pre-warm the RW grant so the gesture-less
      // rotations start with a live grant instead of pausing on the first rotation.
      if (path[0] === "saving" && path[1] === "autoSave" && action.payload.value === true) {
        const dirHandle = dirHandleRef.current;
        if (dirHandle != undefined) {
          void (async () => {
            const granted = await requestRwPermission(dirHandle);
            if (!granted) {
              setLastSave({
                text: "Auto-save not enabled — folder write permission denied",
                severity: "warn",
              });
              return; // don't enable without a live grant
            }
            const next = applyAction(configRef.current, action);
            if (next === configRef.current) {
              return;
            }
            setConfig(next);
            context.saveState(next);
          })();
          return;
        }
      }

      const next = applyAction(configRef.current, action);
      if (next === configRef.current) {
        return; // unchanged
      }
      setConfig(next);
      context.saveState(next);
    },
    [context, chooseSaveFolder, selectBrowserDownload],
  );

  // (Re)render the settings editor on mount and whenever inputs change.
  useEffect(() => {
    context.updatePanelSettingsEditor(
      buildSettingsTree(config, topics, actionHandler, { canPickDir, saveFolderName }),
    );
  }, [context, config, topics, saveFolderName, actionHandler]);

  // The click gesture is live now but gone by the time the worker posts the bytes back, so
  // acquire the RW grant here (query-then-request). The async reply handler then only
  // queries and writes silently — deterministic, no native dialog.
  const prewarmSaveGrant = useCallback(async () => {
    const dirHandle = dirHandleRef.current;
    if (canPickDir && dirHandle != undefined) {
      const granted = await requestRwPermission(dirHandle);
      if (!granted) {
        setLastSave({
          text: "Folder write permission denied — saving as browser download",
          severity: "warn",
        });
      }
    }
  }, []);

  const onSave = useCallback(() => {
    void (async () => {
      await prewarmSaveGrant();
      workerRef.current?.postMessage({ type: "save" });
    })();
  }, [prewarmSaveGrant]);

  const onReset = useCallback(() => {
    workerRef.current?.postMessage({ type: "reset" });
    setForwarded(0);
    setStat(ZERO_STAT);
    setLastSave(undefined);
    setConfirming(undefined);
  }, []);

  /**
   * Snapshot the current buffer into a durable clip on demand.
   *
   * Framing a large window and writing it takes seconds, all of it in the worker, so the only
   * thing the user sees is this button. Disable it and relabel it *before* dispatching, or the
   * click looks like it did nothing and gets repeated.
   */
  const onCacheClip = useCallback(() => {
    if (busyRef.current.has(BUSY_CACHE_CLIP)) {
      return;
    }
    clipsBeforeCacheRef.current = new Set((clipsRef.current ?? []).map((clip) => clip.id));
    beginBusy(BUSY_CACHE_CLIP);
    afterPaint(() => {
      workerRef.current?.postMessage({ type: "trigger", tag: "manual-clip" });
    });
  }, [beginBusy]);

  const onSaveClip = useCallback(
    (id: string) => {
      const key = busySaveClip(id);
      if (busyRef.current.has(key)) {
        return;
      }
      beginBusy(key);
      void (async () => {
        // Still inside the click for the permission request; only the dispatch is deferred.
        await prewarmSaveGrant();
        afterPaint(() => {
          workerRef.current?.postMessage({ type: "requestClipBytes", id });
        });
      })();
    },
    [beginBusy, prewarmSaveGrant],
  );

  /** Request every cached clip, oldest first, and write them in that order. */
  const onSaveAll = useCallback(() => {
    const queued = clipsRef.current ?? [];
    if (queued.length === 0 || busyRef.current.has(BUSY_SAVE_ALL)) {
      return;
    }
    saveAllRemainingRef.current = queued.length;
    beginBusy(BUSY_SAVE_ALL);
    void (async () => {
      await prewarmSaveGrant();
      afterPaint(() => {
        const worker = workerRef.current;
        if (worker == undefined) {
          endBusy(BUSY_SAVE_ALL);
          return;
        }
        for (const clip of queued) {
          worker.postMessage({ type: "requestClipBytes", id: clip.id });
        }
      });
    })();
  }, [beginBusy, endBusy, prewarmSaveGrant]);

  const onDeleteClip = useCallback((id: string) => {
    workerRef.current?.postMessage({ type: "deleteClip", id });
    setConfirming(undefined);
    setExpandedIds((previous) => {
      const next = new Set(previous);
      next.delete(id);
      return next;
    });
  }, []);

  const onClearClips = useCallback(() => {
    workerRef.current?.postMessage({ type: "clearClips" });
    setConfirming(undefined);
    setExpandedIds(new Set());
  }, []);

  const onToggleExpand = useCallback((id: string) => {
    setExpandedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const budget = statSummary(stat, { mode: config.budgetMode, value: settled.budgetValue });
  const captureOn = workerReady && enabledTopics.length > 0;
  const saveDestination = saveFolderName ?? "Browser download";
  const theme = makeTheme(colorScheme);
  const clipsLoaded = clips != undefined;
  const loadedClips = clips ?? [];
  const cacheBytes = loadedClips.reduce((total, clip) => total + clip.byteSize, 0);
  // Newest first on screen; "Save all" still writes chronologically.
  const clipsNewestFirst = [...loadedClips].reverse();
  const hasClips = loadedClips.length > 0;

  const hasBuffer = stat.bufferedMsgs > 0;
  const cachingClip = busy.has(BUSY_CACHE_CLIP);
  const savingAll = busy.has(BUSY_SAVE_ALL);
  const status = bufferStatus(stat, { workerReady, enabledTopics: enabledTopics.length });
  const alert =
    lastSave != undefined && lastSave.severity !== "ok"
      ? { text: lastSave.text, color: lastSave.severity === "error" ? theme.danger : theme.warn }
      : undefined;
  const capBytes = mbToBytes(settled.maxCacheMb);
  const fillStyle: React.CSSProperties = { flex: `1 1 120px` };

  const statRows: Array<{ label: string; value: React.ReactNode }> = [
    { label: "Worker", value: workerReady ? "Ready" : "Starting…" },
    { label: "Capture", value: captureOn ? "On" : "Off" },
    { label: "Topics subscribed", value: `${enabledTopics.length} / ${topics.length}` },
    { label: "Messages forwarded", value: forwarded },
    { label: "Budget used", value: `${budget.used} / ${budget.cap}` },
    { label: "Rotations", value: stat.rotations },
    { label: "Buffered", value: `${stat.bufferedMsgs} msgs / ${stat.channels} channels` },
    { label: "Save destination", value: saveDestination },
    { label: "Last save", value: lastSave?.text ?? "—" },
  ];

  return (
    <div
      style={{
        height: "100%",
        overflowY: "auto",
        // No top padding: it belongs to the sticky zone below, so that zone can pin flush
        // with the top of the scroll area. Left here, scrolled content would slide through
        // the gap above it.
        padding: "0 0.75rem 0.75rem",
        boxSizing: "border-box",
        fontFamily: "inherit",
        fontSize: "0.8125rem",
        lineHeight: 1.5,
        color: theme.fg,
        // Opaque so the sticky zone below has something solid to sit on.
        background: theme.bg,
      }}
    >
      {/* Pinned: the buffer controls and one line of state. This panel shares a layout
          with others and is often short, so these must stay reachable without scrolling.
          Deliberately just the buttons plus one line — the stat grid is not pinned. */}
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 1,
          background: theme.bg,
          // Bleed over the container's side padding, and carry the top padding itself, so
          // the opaque background covers every pixel scrolled content could pass through.
          margin: "0 -0.75rem",
          padding: "0.75rem 0.75rem 0.5rem",
        }}
      >
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "0.5rem",
            maxWidth: CONTROL_ROW_MAX_WIDTH,
          }}
        >
          <ThemedButton
            theme={theme}
            variant="primary"
            style={fillStyle}
            disabled={!workerReady || !hasBuffer}
            title={hasBuffer ? "Write the current buffer to an MCAP file" : "Nothing buffered yet"}
            onClick={onSave}
          >
            <SaveIcon />
            Save to disk
          </ThemedButton>
          <ThemedButton
            theme={theme}
            variant="default"
            style={fillStyle}
            disabled={!workerReady || !hasBuffer || cachingClip}
            title={
              cachingClip
                ? "Framing and writing the clip…"
                : "Snapshot the buffer into the clip cache"
            }
            onClick={onCacheClip}
          >
            <ClipIcon />
            {cachingClip ? "Caching…" : "Cache clip"}
          </ThemedButton>
          {confirming?.kind === "reset" ? (
            <div
              style={{
                ...fillStyle,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "0.35rem",
                color: theme.muted,
              }}
            >
              <span>Discard?</span>
              <ThemedButton theme={theme} variant="link" onClick={onReset}>
                Yes
              </ThemedButton>
              <ThemedButton
                theme={theme}
                variant="link"
                onClick={() => {
                  setConfirming(undefined);
                }}
              >
                No
              </ThemedButton>
            </div>
          ) : (
            <ThemedButton
              theme={theme}
              variant="danger"
              style={fillStyle}
              disabled={!workerReady}
              title="Discard everything in the live buffer"
              onClick={() => {
                setConfirming({ kind: "reset" });
              }}
            >
              <TrashIcon />
              Reset buffer
            </ThemedButton>
          )}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: "0.4rem",
            marginTop: "0.5rem",
            color: status.active ? theme.fg : theme.muted,
          }}
        >
          <span aria-hidden style={{ color: status.active ? theme.success : theme.muted }}>
            ●
          </span>
          <span>
            {status.label} — {budget.used} / {budget.cap}
          </span>
        </div>

        {/* A paused or denied save means data is not reaching the folder. That is far too
            easy to miss in a muted stat row, so it stays pinned and coloured until either
            the next successful save replaces it or the user dismisses it. */}
        {alert != undefined && (
          <Banner color={alert.color} role="alert">
            <span style={{ flex: "1 1 auto", wordBreak: "break-word" }}>{alert.text}</span>
            <ThemedButton
              theme={theme}
              variant="link"
              title="Dismiss"
              style={{ color: alert.color, padding: "0 0.2rem" }}
              onClick={() => {
                setLastSave(undefined);
              }}
            >
              ✕
            </ThemedButton>
          </Banner>
        )}

        {/* Lowering the cache limit past what is already cached would evict clips, so it is
            held here until the user agrees. The number field itself lives in the app's
            settings editor, which the panel cannot render into. */}
        {confirming?.kind === "cacheLimit" && (
          <Banner color={theme.warn}>
            <span style={{ flex: "1 1 auto", wordBreak: "break-word" }}>
              A {confirming.maxCacheMb} MB cache limit will drop {confirming.dropCount} cached clip
              {confirming.dropCount === 1 ? "" : "s"} ({formatBytes(confirming.dropBytes)}). Apply?
            </span>
            <ThemedButton
              theme={theme}
              variant="link"
              style={{ color: theme.warn }}
              onClick={() => {
                onApplyCacheLimit(confirming.maxCacheMb);
              }}
            >
              Apply
            </ThemedButton>
            <ThemedButton
              theme={theme}
              variant="link"
              style={{ color: theme.warn }}
              onClick={onCancelCacheLimit}
            >
              Cancel
            </ThemedButton>
          </Banner>
        )}
      </div>

      <div style={sectionTitleStyle(theme)}>
        <ThemedButton
          theme={theme}
          variant="link"
          title={showDetails ? "Hide details" : "Show details"}
          onClick={() => {
            setShowDetails((previous) => !previous);
          }}
        >
          {showDetails ? "▾" : "▸"} Current buffer
        </ThemedButton>
      </div>

      {showDetails && (
        <div style={{ display: "grid", rowGap: "0.15rem", marginBottom: "1rem" }}>
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
      )}

      {/* Save feedback matters even with the details collapsed, so surface it either way. */}
      {!showDetails && lastSave?.severity === "ok" && (
        <p
          style={{
            margin: "0 0 1rem",
            color: theme.muted,
            fontSize: "0.75rem",
            wordBreak: "break-word",
          }}
        >
          {lastSave.text}
        </p>
      )}

      <div style={sectionTitleStyle(theme)}>
        <span>Cached clips ({clipsLoaded ? loadedClips.length : "…"})</span>
        <span style={{ flex: "1 1 auto" }} />
        {/* These act on the cache, so they live with it rather than at the top of the
            panel. Nothing to act on at zero clips, so they are not rendered at all. */}
        {hasClips &&
          (confirming?.kind === "all" ? (
            <span
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.3rem",
                fontWeight: 400,
                textTransform: "none",
                letterSpacing: "normal",
              }}
            >
              Clear {loadedClips.length}?
              <ThemedButton theme={theme} variant="link" onClick={onClearClips}>
                Yes
              </ThemedButton>
              <ThemedButton
                theme={theme}
                variant="link"
                onClick={() => {
                  setConfirming(undefined);
                }}
              >
                No
              </ThemedButton>
            </span>
          ) : (
            <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <ThemedButton
                theme={theme}
                variant="link"
                disabled={!workerReady || savingAll}
                onClick={onSaveAll}
              >
                {savingAll ? "Saving…" : "Save all"}
              </ThemedButton>
              <ThemedButton
                theme={theme}
                variant="link"
                disabled={!workerReady}
                onClick={() => {
                  setConfirming({ kind: "all" });
                }}
              >
                Clear all
              </ThemedButton>
            </span>
          ))}
      </div>

      <CacheMeter theme={theme} usedBytes={cacheBytes} capBytes={capBytes} />

      <p
        style={{
          margin: "0 0 0.35rem",
          color: theme.muted,
          fontSize: "0.75rem",
        }}
      >
        {formatBytes(cacheBytes)} / {settled.maxCacheMb} MB · {cacheModeLabel(cache)}
      </p>

      {hasClips ? (
        <div>
          {clipsNewestFirst.map((clip) => (
            <ClipRow
              key={clip.id}
              theme={theme}
              clip={clip}
              expanded={expandedIds.has(clip.id)}
              confirmingDelete={confirming?.kind === "clip" && confirming.id === clip.id}
              saving={busy.has(busySaveClip(clip.id))}
              onToggleExpand={() => {
                onToggleExpand(clip.id);
              }}
              onSave={() => {
                onSaveClip(clip.id);
              }}
              onAskDelete={() => {
                setConfirming({ kind: "clip", id: clip.id });
              }}
              onConfirmDelete={() => {
                onDeleteClip(clip.id);
              }}
              onCancelDelete={() => {
                setConfirming(undefined);
              }}
            />
          ))}
        </div>
      ) : (
        <p style={{ margin: 0, color: theme.muted, fontSize: "0.75rem" }}>
          {!clipsLoaded
            ? "Reading the clip cache…"
            : cache.available
              ? "No cached clips yet — a clip is captured on a connection gap, when the tab is hidden, on close, and on each auto-save window. Cached clips survive a reconnect."
              : "Browser storage is unavailable here, so clips cannot be cached. Live capture and Save to disk still work."}
        </p>
      )}
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

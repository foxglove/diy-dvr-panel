# DiyDvrExtension version history

## 0.3.0

- **Capture now survives a reconnect.** The app re-runs the extension's `initPanel` whenever the live connection's presence or context changes, which tears down the panel and terminates its Web Worker — so the entire in-memory buffer was lost at exactly the moment something interesting happened on the wire. The panel now caches **clips** (non-destructive MCAP snapshots of the buffer) in OPFS, the origin's private file system, which outlives any single worker. A freshly-started worker reads the cache back, so clips are still listed after a reconnect.
- **Clips are captured automatically** on four triggers: the connection going quiet for longer than a configurable threshold (`gap>10s`), the tab being hidden (`backgrounded`), the tab or app closing (`closing`), and recovery of an interrupted session (`recovered`). There is also a **Cache clip** button for snapshotting on demand. Snapshotting never disturbs the live buffer, which keeps rolling exactly as before.
- **Rolling backup of the live buffer.** Between clips the current window is mirrored to OPFS every few seconds, guarded so builds never overlap and skipped when no new message has arrived. Whatever a terminated worker left behind is promoted to a `recovered` clip on the next mount, so a hard stop costs at most one mirror interval instead of the whole buffer.
- **Bounded clip cache.** A new **Cache limit (MB)** setting (default 2048) caps the total; whole oldest clips are dropped first. The live buffer and the rolling backup are never evicted.
- **New panel body, built for a small panel.** The three buffer controls — **Save to disk** (the primary action), **Cache clip**, and **Reset buffer** — plus a one-line status such as `● Recording — 0.5s / 60s` are pinned to the top, so they stay reachable however far you scroll and however short the panel is. The detailed stat rows sit behind a disclosure and are collapsed by default. Below that, a **Cached clips** list: each row shows its trigger as a chip plus capture time, duration, size, and message count, expands into a per-topic message-count table, and carries its own save and delete controls. **Save all** and **Clear all** live in the Cached-clips header, with the cache-fullness meter that turns amber and then red as the cap approaches — eviction drops the oldest clip silently, so it is worth seeing coming. Destructive actions all confirm inline, including **Reset buffer**.
- **New settings**, under a **Clip cache** node: **Cache limit (MB)** and **Gap trigger (seconds)** (default 10).
- **Clip files are named after their clip**, e.g. `diy-dvr-gap-1785781144009.mcap`. **Save all** writes several files in one pass, and the previous `diy-dvr-<now>.mcap` naming would have given them the same name and silently overwritten files. The File System Access permission handshake is unchanged.
- **Works with or without synchronous file access.** OPFS synchronous access handles are not available in every worker across the web and desktop builds, so the storage wrapper detects support at runtime and implements both the synchronous and asynchronous paths behind one interface. If browser storage cannot be used at all, the panel says so and live capture and saving carry on unaffected.
- **Testable capture core.** The worker's capture logic moved into `captureEngine.ts`, which takes an injected storage backend, clock, and output sink, leaving `mcap.worker.ts` as a thin `postMessage` adapter. This mirrors the existing approach for `settings.ts`. Adds the repo's first test suite — Jest + ts-jest in a Node environment, with 44 unit tests covering the ring buffer, all clip triggers, session recovery, cache eviction, and the new settings; CI now runs them.

## 0.2.6

- **MIT licensed.** Replaces the previous proprietary "all rights reserved" LICENSE, so the extension can be distributed through the public [Foxglove extension registry](https://github.com/foxglove/extension-registry). Matches the other Foxglove-published registry entries.
- **Reproducible packaging.** `pnpm run package` now normalizes zip timestamps so a given source tree always produces a byte-identical `.foxe`. The registry pins an exact `sha256sum` per release, and `foxglove-extension package` was stamping the auto-created `dist/` folder entry with the build wall-clock time, so two builds of identical sources hashed differently.
- **CI and release automation.** Pull requests now run lint, typecheck, packaging, the offline MCAP writer check, and a reproducibility check. Tagging `v*` builds the `.foxe`, attaches it to the release, and emits the ready-to-paste `extensions.json` entry for the registry.
- **Housekeeping.** Added `repository` / `bugs` metadata, pinned the package manager, moved pnpm settings out of the `package.json` `pnpm` field (ignored by pnpm >=10) into `pnpm-workspace.yaml` so the `eslint-plugin-import` override applies again, and removed the `pretest` script, which called a `foxglove-extension` subcommand that does not exist.

## 0.2.5

- **Save-handler readability refactor** — the worker `"saved"` callback now delegates to a testable `persistCapture` helper (owns the "try folder → fall back to download" decision, query-only on permission) plus a pure `saveStatusText` mapper, flattening the previously nested async block. No behavior change.
- **Customer-facing docs** — rewrote the README to be concise and user-focused (what it does, features, how to use) instead of implementation internals, since it renders in the app's Extensions view. Replaced the informal package `description` with professional copy.

## 0.2.4

- **Panel-body UI polish** — the save-folder picker now lives solely in the panel Settings "Save destination" select; the in-body "Choose save folder…" button and the Change / Use-browser-download links have been removed (the informational "Save destination" stats row stays). The "Topics, budget, and auto-save are in panel Settings (gear icon)" hint moves to the top of the body, above the button row, so it's the first thing a user sees. Buttons are now square (`borderRadius: 0`) to match Foxglove's UI, and the body reduces to a `Save MCAP` / `Reset buffer` row. No capture, worker, or permission behavior changed.

## 0.2.3

- **Deterministic silent save** — the File System Access write-permission handshake is now only ever *requested* inside a live user gesture (the Save button click, the Auto-save toggle, or the "Save destination" settings action), and the gesture-less worker "saved" callback only ever *queries* the grant. Chromium only grants `requestPermission({mode:"readwrite"})` under transient activation and does not durably keep the grant, so requesting it from the async callback failed silently and fell back to the native Save dialog. Manual **Save** now acquires the grant inside the click and writes silently every time; the permission helper was split into `requestRwPermission` (gesture-only) and `hasRwPermission` (query-only).
- **Honest auto-save** — auto-save rotations write silently while the grant is live; when the grant has lapsed (reload / focus loss / inactivity) they no longer pop a dialog or silently download but show "Auto-save paused — click Save to re-grant folder access". Turning Auto-save on pre-warms the grant inside that toggle gesture and won't enable if permission is denied.
- **Choose-folder is a settings field** — the Saving node's detached "Choose folder…" header action is replaced by a "Save destination" select field (current folder / Choose folder… / Browser download). The in-panel body picker button remains as a reliable gesture path.

## 0.2.2

- **Schema time field matches the data** — synthesized ROS2 schemas now declare the nanoseconds field as `nsec` (e.g. `header.stamp.nsec`), matching Foxglove's decoded message representation and its own `foxglove.*` schemas, instead of the ROS2 IDL name `nanosec`. The panel encodes the decoded object verbatim, so a saved MCAP's schema now agrees with its message data.
- **Silent save no longer prompts** — write permission on the chosen directory is now requested at folder-pick time, inside the user gesture (later saves and auto-save rotations have no gesture, so the request would otherwise fail and fall back to the native Save dialog). A folder is only accepted once readwrite permission is granted.
- **Grouped save-destination settings** — the settings sidebar now has a dedicated "Saving" node holding the Save folder display, the Choose-folder action, and Auto-save, so the picker sits with the controls it relates to rather than at the top of General. Budget mode / Lookback stay in General.
- **Auto-save gated on a save folder** — Auto-save is only shown/enabled once a save folder is set, and the panel never sends `autoSave: true` to the worker without a folder, so a stale persisted flag can't trigger download-dialog rotations.

## 0.2.1

- **Timeline keyed off published time** — the buffered/saved `logTime` now comes from the message's published time (falling back to receive time), so a saved MCAP's timestamps reflect the source clock. The ring buffer is kept sorted by `logTime`, so span reporting and oldest-first eviction stay correct even when a source delivers times out of order (e.g. a looping replay). "Budget used" is floored at zero and can never render negative.
- **Persistent save folder** — the picked directory handle is stored in IndexedDB, so the chosen "Save destination" survives panel remounts and reloads. Permission is re-verified lazily at save time; if it can't be re-granted the save falls back to a browser download but the handle is kept for a later grant.
- **Usable from the panel body** — a "Choose save folder…" button (and Change / Use-browser-download affordances) is surfaced directly in the panel, plus a hint pointing to panel Settings for topics, budget, and auto-save.
- **Native-feeling UI** — the body themes to the app color scheme (light/dark), uses styled buttons and tidy label/value rows, and drops the redundant in-body title.
- **Test server** — `test-server/serve.py` no longer calls `clear_session()` on each loop, so a connected client keeps its channels/topics continuous across the loop boundary instead of dropping them.

## 0.2.0

- **Panel settings editor** — configure the panel from the layout settings sidebar; config is persisted with the layout (`saveState` / `initialState`).
- **Per-topic allowlist** — collapsible Topics node with a toggle per advertised topic (default on); the panel subscribes to only the enabled topics and re-subscribes when the set changes.
- **Lookback budget** — bound the in-memory buffer by max seconds (time mode) or max megabytes (byte mode, measuring the re-encoded JSON payload); the worker evicts the oldest data past the budget.
- **Auto-save on rotation** — when enabled, exceeding the budget snapshots the whole window, clears it synchronously, and frames it to an MCAP instead of dropping data, yielding contiguous rotated files with no gaps.
- **Silent save to a chosen folder** — pick a directory once (File System Access API, Chromium only) and both manual saves and auto-save rotations write `.mcap` files into it silently; falls back to a browser download when unavailable, no folder is chosen, or permission is denied.
- **UI readout** — budget used vs cap, rotation count, capture on/off, topics subscribed, buffered msgs/channels, save destination, and a last-save status line. Save / Reset buttons retained (manual Save is non-destructive).

## 0.1.0

- Initial spin-out from the DIY DVR spike.
- Web Worker capture pipeline: subscribe to live topics, JSON-encode messages (real schemas from the SDK / bundled ROS2 defs, base64 byte arrays), frame to a fully indexed MCAP.
- Dump-on-demand: write the buffer to an `.mcap` file for full scrub-back in a new tab.

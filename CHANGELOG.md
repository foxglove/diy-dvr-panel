# DiyDvrExtension version history

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

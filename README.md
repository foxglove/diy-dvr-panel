# DIY DVR

Record data from a live [Foxglove](https://foxglove.dev) WebSocket connection to an MCAP file, straight from a panel — with no changes to the core app. Keep a rolling, time- or size-bounded buffer of recent messages and save it on demand, or auto-save each window as the limit is reached. Re-open the saved file in a new tab for full scrub-back.

## Features

- **Capture live data** from any Foxglove WebSocket connection into a rolling in-memory buffer.
- **Choose what to record** — all topics by default, or switch individual topics off.
- **Bounded lookback** — keep the last N seconds or N megabytes; older data rolls off.
- **Save on demand** — write the current buffer to an `.mcap` file at any time.
- **Auto-save** — automatically write each window to a file as the limit is reached, so nothing is dropped.
- **Choose a save folder** — pick a folder once and saves land there silently, with no per-file dialog.
- Works in both the **desktop and web** apps.

## Usage

1. Install the extension and add the **DIY DVR** panel to your layout.
2. Connect Foxglove to your live WebSocket source.
3. Open the panel's **Settings** (gear icon) to choose which topics to record, the lookback budget (time or size), auto-save, and a save destination.
4. Click **Save MCAP** to dump the current buffer, or turn on **Auto-save** to write each window automatically.
5. Open the saved `.mcap` file as a new data source — it plays back with full scrub-back, exactly like the live view.

> **Silent saving** (no save dialog on every file) requires a Chromium-based build — the desktop app, or Chrome / Edge for the web app. Choose a save folder in Settings to enable it; otherwise files are saved as browser downloads.

## Development

Built with the `@foxglove/extension` SDK; uses `pnpm`.

```sh
pnpm install
pnpm run local-install   # build + install into the desktop app, then reload
```

To drive the panel without hardware, the bundled `test-server/` streams any MCAP over a Foxglove WebSocket — see [`test-server/README.md`](test-server/README.md).

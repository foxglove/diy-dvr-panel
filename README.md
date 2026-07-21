# DIY DVR Extension

A [Foxglove](https://foxglove.dev) extension panel that adds **DVR-style lookback to a live `ws://` connection** without touching the app's timeline player.

The panel subscribes to a configurable set of topics on the active live connection, buffers their messages in a rolling in-memory ring, and dumps the buffer to an MCAP file on demand or on a rotation trigger. Opening that file as a new tab gives full scrub-back with zero viz changes.

## Features

- Capture live messages off any Foxglove WebSocket source into an in-memory ring buffer.
- **Panel settings editor** — configure everything from the layout settings sidebar; the config is persisted with the layout.
- **Topic selection** — choose which topics to DVR via per-topic toggles (default: all advertised topics).
- **Lookback budget** — bound the buffer by max seconds *or* max megabytes; oldest data is evicted past the budget. The byte budget measures the re-encoded JSON payload size (post-base64), not the wire size.
- **Auto-save on rotation** — instead of silently dropping the oldest data when the budget is hit, flush the buffer to a file and start a fresh window.
- **Dump on demand** — write the current buffer to an `.mcap` file at any time (non-destructive — the buffer keeps filling).
- **Silent save to a chosen folder** — pick a directory (from the panel body or the settings sidebar) and both manual saves and auto-save rotations write files into it with no per-file dialog (Chromium-based builds only — Chrome/Edge desktop or web; elsewhere files download instead). The chosen folder is **persisted** (in IndexedDB), so it survives panel remounts and reloads; permission is re-verified at save time and falls back to a browser download if it can't be re-granted.
- Runs the ring buffer and MCAP encoding in a **Web Worker**, off the main thread.
- Works in both the desktop and web builds of Foxglove.

## How It Works

Foxglove hands an extension panel **decoded message objects** and a schema *name* — never the raw wire bytes or the schema *definition*. So the panel re-encodes:

1. The panel subscribes to the selected topics and forwards each decoded message to a Web Worker.
2. The worker JSON-encodes every message (byte arrays → base64), resolves a real schema per topic by name, and appends it to a bounded ring buffer.
3. On dump / auto-save, the worker frames the buffer into a **fully indexed** MCAP via `@mcap/core` and hands the bytes back to the panel. The panel writes the file — silently into a previously-chosen directory when available, otherwise as a browser download.
4. You open that file as a new data source for full scrub-back — no changes to the core app required.

Because the output is JSON-encoded MCAP with schemas that Foxglove reads natively, the dumped file re-opens and renders exactly like the live view.

## Technical Details

[Foxglove](https://foxglove.dev) allows developers to create [extensions](https://docs.foxglove.dev/docs/visualization/extensions/introduction) — custom code loaded and executed inside the Foxglove application, authored in TypeScript against the `@foxglove/extension` SDK.

### Web Worker bundling

The extension framework has no first-class worker API, and the app loads the extension as a single `dist/extension.js` bundle — so a separate worker chunk can't be resolved from the app sandbox. Instead:

- `src/mcap.worker.ts` (with `@mcap/core` and the schema/encoder modules) is pre-bundled to a single self-contained string by `scripts/bundle-worker.mjs` (esbuild) into `src/generatedWorkerSource.ts`.
- The panel launches the worker from a `Blob` URL: `new Worker(URL.createObjectURL(new Blob([source])))`.
- The worker and all its dependencies travel inside the extension bundle. The generated file is git-ignored; `build` regenerates it.

### Schema resolution

A panel only sees a schema *name*, so the worker resolves the definition itself (`src/schemaRegistry.ts`):

- `foxglove.*` → the SDK's published JSON Schemas (`@foxglove/schemas/jsonschema`).
- ROS2 (`sensor_msgs/msg/*`, etc.) → generated from bundled ROS2 (Humble) definitions (`@foxglove/rosmsg-msgs-common`) via `src/rosDefToJsonSchema.ts`.
- Unknown / custom schemas → shape-inferred from the observed messages (`src/inferSchema.ts`).

Byte arrays are base64-encoded to match how Foxglove's own JSON Schemas type `uint8[]` fields (`{ type: "string", contentEncoding: "base64" }`); the app's JSON codec decodes those back to a `Uint8Array` on read, so images render and byte fields stay compact (~1.33× vs ~4× for a JSON number array). `int8[]` (e.g. `OccupancyGrid.data`) intentionally stays a number array — the app's `normalizeInt8Array` rejects a `Uint8Array`.

### Fidelity caveats

The re-encoder writes decoded objects back to JSON, so:

- **Original wire encoding is not preserved** — output is JSON-encoded MCAP. Acceptable because Foxglove reads it back natively.
- **int64 / uint64** (`BigInt`) fields are cast to `number`; large magnitudes lose precision (fine for typical timestamps/ids).
- Binary blobs (images, point clouds) bloat under base64 (~1.33×) — a reason to select only the topics you need when using a byte budget.
- The worker runs from a `Blob` URL. In the web app (`app.foxglove.dev`), a Content-Security-Policy that blocks `worker-src blob:` would prevent capture; verify in the target web build (the desktop app is unaffected).
- The chosen save folder is persisted across reloads by storing the (structured-cloneable) directory handle in IndexedDB. The handle survives, but the OS may still require a permission re-grant on the first save after a reload; if it can't be re-granted, that save falls back to a browser download.

## Develop

Extension development uses the `pnpm` package manager to install dependencies and run build scripts.

```sh
pnpm install
```

To build and install the extension into your local Foxglove desktop app:

```sh
pnpm run local-install
```

Open the Foxglove desktop app (or `ctrl-R` to refresh if it is already open). The **DIY DVR** panel is now available to add.

### Validate the MCAP writer offline

No browser needed — exercises `buildMcap` + `schemaRegistry` + `inferSchema` and writes a sample:

```sh
pnpm run validate:mcap /tmp/sample.mcap
mcap doctor /tmp/sample.mcap && mcap list schemas /tmp/sample.mcap && mcap info /tmp/sample.mcap
```

Expected: doctor passes, `jsonschema` schemas present, indexed (info reports channels/chunks).

### Test against a live `ws://` source

Use the bundled `test-server/` harness — it streams any MCAP over a Foxglove WebSocket, looping forever, with original schemas/encodings preserved. See [`test-server/README.md`](test-server/README.md).

```sh
uv run test-server/serve.py --file /path/to/recording.mcap   # ws://127.0.0.1:8767
```

Then in the app: **Open connection → Foxglove WebSocket → `ws://127.0.0.1:8767`**, add the **DIY DVR** panel, and watch the counters climb.

## Package

Extensions are packaged into `.foxe` files containing the metadata (package.json) and the built code.

Before packaging, set `name`, `publisher`, `version`, and `description` in _package.json_, and add a real license. Then:

```sh
pnpm run package
```

This produces a `.foxe` file in the local directory.

## Publish

You can publish the extension to the public registry or privately for your organization. See: https://docs.foxglove.dev/docs/visualization/extensions/publish/#packaging-your-extension

# test-server

A local live-source stand-in: reads an MCAP and streams it over a Foxglove WebSocket, looping forever. Use it to drive the DIY DVR panel (or the app) without real hardware.

## Fidelity

Re-advertises each channel with its **original schema + message encoding** straight from the MCAP (protobuf stays protobuf, json stays json) and replays messages in log-time order paced to wallclock. A realistic stand-in for a real `ws://` feed — and higher fidelity than the panel's own lossy JSON re-encoder, which is the point: it exercises the capture path against real wire formats.

## Usage

Needs [`uv`](https://docs.astral.sh/uv/). Dependencies (`foxglove-sdk`, `mcap`) are declared inline; `uv run` fetches them automatically.

```sh
uv run serve.py --file /path/to/recording.mcap        # loops forever on ws://127.0.0.1:8765
uv run serve.py --file rec.mcap --once                # play through once, then stop
uv run serve.py --file rec.mcap --port 9000           # override the default port
uv run serve.py --file rec.mcap --host 0.0.0.0        # expose on the network
```

Defaults to port **8765**, the standard Foxglove WebSocket port — the app's **Open connection** dialog defaults to it, so it connects to this server with no extra config. Override with `--port`.

## Connect

In the Foxglove app: **Open connection → Foxglove WebSocket → `ws://127.0.0.1:8765`** (the default). Then add the **DIY DVR** panel and hit Save.

## Credit

Adapted from `foxglove-sdk`'s `ws-stream-mcap` example. For play/pause/seek support, see the sibling `ws-playback-control-mcap` example in the SDK.

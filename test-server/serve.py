# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "foxglove-sdk>=0.4.0",
#     "mcap>=1.2",
# ]
# ///
"""Stream an MCAP file over a Foxglove WebSocket, looping forever.

A faithful "poor man's live source" for testing the DVR spike: it re-advertises
each channel with its ORIGINAL schema + message encoding straight from the MCAP,
then replays messages in log-time order paced to wallclock. Unlike the spike's
lossy JSON re-encoder, this preserves the wire format, so it's a realistic stand-in
for a real ws:// robot feed.

Adapted from the official Foxglove SDK example
(foxglove-sdk/python/foxglove-sdk-examples/ws-stream-mcap/main.py). Rewrapped here
as a zero-install PEP 723 script and defaulted to a non-conflicting port.

Usage (needs `uv`: https://docs.astral.sh/uv/):
    uv run serve.py --file path/to/recording.mcap
    uv run serve.py --file rec.mcap --port 8767 --once

Then point the Foxglove app (or the DIY DVR panel) at ws://127.0.0.1:8767.
"""

import argparse
import logging
import time
from typing import Optional

import foxglove
import mcap.reader
import mcap.records
from foxglove import Channel, Schema
from foxglove.websocket import Capability, WebSocketServer

# Default to 8767: the Foxglove app already listens on 8765 (the default Foxglove
# WS port) locally, so bind elsewhere to avoid the conflict.
DEFAULT_PORT = 8767

channels: dict[str, Channel] = {}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", type=str, required=True, help="Path to the .mcap file")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--host", type=str, default="127.0.0.1")
    parser.add_argument(
        "--once",
        action="store_true",
        help="Play through a single time instead of looping forever",
    )
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    server = foxglove.start_server(
        name=args.file,
        port=args.port,
        host=args.host,
        capabilities=[Capability.Time],
    )
    logging.info("Serving %s on ws://%s:%d", args.file, args.host, args.port)

    try:
        while True:
            stream_until_done(args.file, server)
            if args.once:
                logging.info("Done (--once); stopping")
                break
            logging.info("Looping")
            # Do NOT call server.clear_session() here. It assigns a new session ID and
            # re-sends ServerInfo, which the client reads as "this is a new server
            # instance" and responds to by discarding its channel state — that is what
            # caused topics to disappear on every loop. A fresh TimeTracker per lap plus
            # the existing broadcast_time() calls reset the client's clock at each loop
            # boundary; channels stay advertised because we never touch the session.
    except KeyboardInterrupt:
        pass
    finally:
        server.stop()


def stream_until_done(file_name: str, server: WebSocketServer) -> None:
    tracker: Optional[TimeTracker] = None
    with open(file_name, "rb") as f:
        reader = mcap.reader.make_reader(f)
        for mcap_schema, mcap_chan, mcap_msg in reader.iter_messages():
            if tracker is None:
                tracker = TimeTracker(offset_ns=mcap_msg.log_time)

            tracker.sleep_until(mcap_msg.log_time)

            if tracker.notify() is not None:
                server.broadcast_time(tracker.now_ns)

            channel = get_channel(mcap_schema, mcap_chan)
            channel.log(mcap_msg.data)


def get_channel(
    mcap_schema: Optional[mcap.records.Schema],
    mcap_channel: mcap.records.Channel,
) -> Channel:
    """Return (creating on first sight) a Channel mirroring the MCAP channel/schema."""
    existing = channels.get(mcap_channel.topic)
    if existing is not None:
        return existing

    schema = (
        None
        if mcap_schema is None
        else Schema(
            name=mcap_schema.name,
            encoding=mcap_schema.encoding,
            data=mcap_schema.data,
        )
    )
    channel = Channel(
        topic=mcap_channel.topic,
        message_encoding=mcap_channel.message_encoding,
        schema=schema,
    )
    channels[mcap_channel.topic] = channel
    logging.info(
        "Advertising %s (%s / %s)",
        mcap_channel.topic,
        mcap_channel.message_encoding,
        mcap_schema.name if mcap_schema else "no schema",
    )
    return channel


class TimeTracker:
    """Maps file timestamps to wallclock so playback runs at real speed."""

    def __init__(self, *, offset_ns: int) -> None:
        self._offset_ns = offset_ns
        self.now_ns = offset_ns
        self._notify_interval_ns = 1e9 / 60
        self._notify_last = 0
        self._start = time.time_ns()

    def sleep_until(self, offset_ns: int) -> None:
        elapsed = time.time_ns() - self._start
        delta = offset_ns - self._offset_ns - elapsed
        if delta > 0:
            time.sleep(delta / 1e9)
        self.now_ns = offset_ns

    def notify(self) -> Optional[int]:
        if self.now_ns - self._notify_last > self._notify_interval_ns:
            self._notify_last = self.now_ns
            return self.now_ns
        return None


if __name__ == "__main__":
    main()

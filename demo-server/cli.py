"""CLI parsing for the factory-nav demo server."""

from __future__ import annotations

import argparse

DEFAULT_RATE_HZ = 20.0
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
DEFAULT_SEED = 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Synthetic Foxglove WebSocket server: a warehouse robot driving "
            "dock-to-dock, planning around racks, and hitting a random fault "
            "every 5-20 s. Streams map / plan / pose / tf / scene / odom / imu "
            "/ battery / status / diagnostics for the DIY DVR panel demo."
        )
    )
    parser.add_argument(
        "--rate-hz",
        default=DEFAULT_RATE_HZ,
        type=float,
        help="Simulation + publish rate (Hz).",
    )
    parser.add_argument(
        "--host",
        default=DEFAULT_HOST,
        help="WebSocket bind host (use 0.0.0.0 to expose on all interfaces).",
    )
    parser.add_argument(
        "--port",
        default=DEFAULT_PORT,
        type=int,
        help="WebSocket bind port.",
    )
    parser.add_argument(
        "--seed",
        default=DEFAULT_SEED,
        type=int,
        help="RNG seed for fault timing + sensor noise (deterministic runs).",
    )
    return parser.parse_args()

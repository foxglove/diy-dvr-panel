"""Random fault injector: the "issue" that fires every 5-20 seconds.

Each fault mutates a shared `Perturbations` object that the main loop reads to
distort motion/sensors, trips the mission state machine into ERROR, and emits a
foxglove.Log line. Faults are the point of the demo: run the sim, watch an
issue land, dump the DVR buffer to capture the window around it.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from enum import Enum


class FaultKind(str, Enum):
    MOTOR_STALL = "motor_stall"
    IMU_TILT = "imu_tilt"
    BATTERY_SAG = "battery_sag"
    LOCALIZATION_JUMP = "localization_jump"
    OBSTACLE_BLOCKING = "obstacle_blocking"


@dataclass
class Perturbations:
    """Live effect state, read by the main loop each tick."""

    speed_scale: float = 1.0
    tilt_spike: float = 0.0  # rad
    accel_spike: float = 0.0  # m/s^2
    battery_sag: float = 0.0  # volts
    # One-shot effects (consumed and cleared by the main loop):
    loc_jump: tuple[float, float] | None = None
    blocker: tuple[float, float, float] | None = None  # (x, y, radius)
    # Bookkeeping for timed effects:
    _active_until: float = 0.0
    active_kind: FaultKind | None = None

    def clear_timed(self) -> None:
        self.speed_scale = 1.0
        self.tilt_spike = 0.0
        self.accel_spike = 0.0
        self.battery_sag = 0.0
        self.active_kind = None


@dataclass
class FaultEvent:
    kind: FaultKind
    message: str
    level: str  # "warning" | "error"


MIN_INTERVAL_S = 5.0
MAX_INTERVAL_S = 20.0


@dataclass
class FaultContext:
    now: float
    robot_xy: tuple[float, float]
    robot_yaw: float
    path: list[tuple[float, float]] = field(default_factory=list)


class FaultInjector:
    def __init__(self, rng: random.Random, *, start_time: float) -> None:
        self._rng = rng
        self.pert = Perturbations()
        self._next_at = start_time + rng.uniform(MIN_INTERVAL_S, MAX_INTERVAL_S)

    def _schedule_next(self, now: float) -> None:
        self._next_at = now + self._rng.uniform(MIN_INTERVAL_S, MAX_INTERVAL_S)

    def update(self, ctx: FaultContext) -> FaultEvent | None:
        now = ctx.now
        # Expire any timed effect that has run its course.
        if self.pert.active_kind is not None and now >= self.pert._active_until:
            self.pert.clear_timed()

        if now < self._next_at or self.pert.active_kind is not None:
            return None

        kind = self._rng.choice(list(FaultKind))
        event = self._fire(kind, ctx)
        self._schedule_next(now)
        return event

    def _fire(self, kind: FaultKind, ctx: FaultContext) -> FaultEvent:
        p = self.pert
        now = ctx.now

        if kind is FaultKind.MOTOR_STALL:
            p.speed_scale = 0.0
            p.active_kind = kind
            p._active_until = now + 2.5
            return FaultEvent(kind, "Motor controller stall on drive axis", "error")

        if kind is FaultKind.IMU_TILT:
            p.tilt_spike = 0.25
            p.accel_spike = 4.0
            p.active_kind = kind
            p._active_until = now + 1.5
            return FaultEvent(kind, "IMU reports abnormal chassis tilt", "warning")

        if kind is FaultKind.BATTERY_SAG:
            p.battery_sag = 3.0
            p.active_kind = kind
            p._active_until = now + 2.0
            return FaultEvent(kind, "Battery pack undervoltage sag detected", "warning")

        if kind is FaultKind.LOCALIZATION_JUMP:
            angle = self._rng.uniform(-math.pi, math.pi)
            mag = self._rng.uniform(0.4, 0.8)
            p.loc_jump = (mag * math.cos(angle), mag * math.sin(angle))
            return FaultEvent(kind, "Localization discontinuity: pose jump", "warning")

        # OBSTACLE_BLOCKING: drop a blocker ~2.5 m ahead along the current path.
        bx, by = _point_ahead(ctx, distance=2.5)
        p.blocker = (bx, by, 0.5)
        return FaultEvent(kind, "Unexpected obstacle blocking planned route", "error")


def _point_ahead(ctx: FaultContext, *, distance: float) -> tuple[float, float]:
    """A point `distance` meters ahead along the path, or dead ahead if no path."""
    if len(ctx.path) >= 2:
        remaining = distance
        for i in range(len(ctx.path) - 1):
            ax, ay = ctx.path[i]
            bx, by = ctx.path[i + 1]
            seg = math.hypot(bx - ax, by - ay)
            if seg < 1e-6:
                continue
            if seg >= remaining:
                t = remaining / seg
                return ax + (bx - ax) * t, ay + (by - ay) * t
            remaining -= seg
        return ctx.path[-1]
    x, y = ctx.robot_xy
    return x + distance * math.cos(ctx.robot_yaw), y + distance * math.sin(ctx.robot_yaw)

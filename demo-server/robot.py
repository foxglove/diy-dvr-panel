"""Differential-drive robot state and a pure-pursuit path follower.

The robot chases a lookahead point along the planned polyline, producing a
smooth pose + body-twist stream. The follower is intentionally simple: it is
here to make the 3D scene move believably, not to be a controls reference.
"""

import math
from dataclasses import dataclass

from lib.pathing import advance_along_path

MAX_SPEED = 1.2  # m/s cruise
MAX_YAW_RATE = 1.5  # rad/s
LOOKAHEAD = 0.6  # m — carrot distance along the path (shorter = tighter corners)
GOAL_TOLERANCE = 0.35  # m — "reached" radius
ACCEL = 1.5  # m/s^2 — speed slew toward target
HEADING_GAIN = 2.5  # rad/s per rad of heading error (proportional steering)
HEADING_SLOW_BAND = math.pi / 3  # >60 deg off: pivot in place (no forward creep)
APPROACH_BAND = 2 * LOOKAHEAD  # m from goal where the follower starts easing off


def _wrap(angle: float) -> float:
    """Wrap an angle to [-pi, pi]."""
    return math.atan2(math.sin(angle), math.cos(angle))


@dataclass
class RobotState:
    x: float
    y: float
    yaw: float
    v: float = 0.0  # linear speed (m/s)
    w: float = 0.0  # yaw rate (rad/s)

    @property
    def xy(self) -> tuple[float, float]:
        return (self.x, self.y)


def step(
    state: RobotState,
    path: list[tuple[float, float]],
    dt: float,
    *,
    speed_scale: float = 1.0,
) -> tuple[RobotState, bool]:
    """Advance one tick along `path`. Returns (new_state, reached_goal).

    `speed_scale` in [0,1] throttles the target speed — faults use it to stall
    the robot without tearing down the follower.
    """
    if not path:
        decel = max(0.0, state.v - ACCEL * dt)
        return RobotState(state.x, state.y, state.yaw, v=decel, w=0.0), False

    goal = path[-1]
    dist_to_goal = math.hypot(goal[0] - state.x, goal[1] - state.y)
    if dist_to_goal <= GOAL_TOLERANCE:
        return RobotState(state.x, state.y, state.yaw, v=0.0, w=0.0), True

    lx, ly = advance_along_path(path, state.xy, LOOKAHEAD)
    heading_to_carrot = math.atan2(ly - state.y, lx - state.x)
    yaw_err = _wrap(heading_to_carrot - state.yaw)

    # Proportional heading control. Clamped to the yaw-rate limit; when badly
    # misaligned the robot pivots in place (turn_factor -> 0 below) instead of
    # orbiting the carrot.
    w = max(-MAX_YAW_RATE, min(MAX_YAW_RATE, HEADING_GAIN * yaw_err))

    # Suppress forward speed while off-heading (pivot first), and ease off near
    # the goal so the follower converges instead of overshooting. `approach_factor`
    # uses straight-line distance to the goal; waypoints sit in open aisles so the
    # goal is never around a corner where that would under-read remaining travel.
    turn_factor = max(0.0, 1.0 - abs(yaw_err) / HEADING_SLOW_BAND)
    approach_factor = min(1.0, dist_to_goal / APPROACH_BAND)
    target_v = MAX_SPEED * speed_scale * turn_factor * approach_factor

    v = state.v + max(-ACCEL * dt, min(ACCEL * dt, target_v - state.v))
    yaw = _wrap(state.yaw + w * dt)
    x = state.x + v * math.cos(yaw) * dt
    y = state.y + v * math.sin(yaw) * dt
    return RobotState(x, y, yaw, v=v, w=w), False

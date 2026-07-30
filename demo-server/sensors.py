"""Synthetic IMU and battery models derived from robot motion.

Both emit plain dicts for JSON channels so a Plot panel can address each field
by name. Faults perturb these through explicit arguments (tilt/accel spike,
battery sag) rather than reaching into internal state.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass

from robot import RobotState

GRAVITY = 9.81


def imu_reading(
    state: RobotState,
    prev_v: float,
    dt: float,
    rng: random.Random,
    *,
    tilt_spike: float = 0.0,
    accel_spike: float = 0.0,
) -> dict[str, object]:
    """IMU sample from the robot's body-frame motion plus sensor noise.

    `tilt_spike` (rad) and `accel_spike` (m/s^2) are injected by the IMU fault.
    """
    lin_accel = (state.v - prev_v) / max(dt, 1e-3)
    roll = tilt_spike * 0.6 + rng.gauss(0, 0.01)
    pitch = tilt_spike + rng.gauss(0, 0.01)

    return {
        "linear_acceleration": {
            "x": lin_accel + accel_spike + rng.gauss(0, 0.05),
            "y": state.v * state.w + rng.gauss(0, 0.05),  # centripetal
            "z": GRAVITY * math.cos(pitch) + rng.gauss(0, 0.05),
        },
        "angular_velocity": {
            "x": rng.gauss(0, 0.01),
            "y": rng.gauss(0, 0.01),
            "z": state.w + rng.gauss(0, 0.02),
        },
        "orientation_rpy": {"roll": roll, "pitch": pitch, "yaw": state.yaw},
    }


@dataclass
class Battery:
    """Coulomb-ish battery: drains with motion, recovers while charging."""

    percentage: float = 100.0
    drain_driving: float = 0.35  # %/s while cruising
    drain_idle: float = 0.02  # %/s parked but powered
    charge_rate: float = 4.0  # %/s at a charging bay

    def step(self, dt: float, *, moving: bool, charging: bool, sag: float = 0.0) -> dict[str, object]:
        if charging:
            self.percentage = min(100.0, self.percentage + self.charge_rate * dt)
        else:
            rate = self.drain_driving if moving else self.drain_idle
            self.percentage = max(0.0, self.percentage - rate * dt)

        # Open-circuit voltage curve for a 6S li-ion pack (~18..25.2V), dragged
        # down transiently by `sag` (fault-injected under-voltage event).
        soc = self.percentage / 100.0
        voltage = 18.0 + 7.2 * soc - sag
        current = (-6.0 if (moving and not charging) else 0.0) + (4.0 if charging else 0.0)
        return {
            "percentage": round(self.percentage, 2),
            "voltage": round(voltage, 3),
            "current": round(current, 3),
            "charging": charging,
        }

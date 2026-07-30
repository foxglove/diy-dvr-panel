"""JSON Schema (Draft-07) dicts for the three JSON channels.

These shapes match exactly what `sensors.imu_reading` / `sensors.Battery.step`
return and what `main.py` publishes on `/status`, so a Plot panel can address
each scalar by name (e.g. `/imu.linear_acceleration.x`).
"""

from __future__ import annotations

_NUMBER = {"type": "number"}


def _vec3(*keys: str) -> dict[str, object]:
    return {"type": "object", "properties": {k: _NUMBER for k in keys}}


# /imu — nested accel + gyro + orientation. Mirrors sensors.imu_reading().
IMU_SCHEMA: dict[str, object] = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "properties": {
        "linear_acceleration": _vec3("x", "y", "z"),
        "angular_velocity": _vec3("x", "y", "z"),
        "orientation_rpy": _vec3("roll", "pitch", "yaw"),
    },
}

# /battery — mirrors sensors.Battery.step().
BATTERY_SCHEMA: dict[str, object] = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "properties": {
        "percentage": _NUMBER,
        "voltage": _NUMBER,
        "current": _NUMBER,
        "charging": {"type": "boolean"},
    },
}

# /status — mission state + human-readable detail (State Transitions panel).
STATUS_SCHEMA: dict[str, object] = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "properties": {
        "state": {"type": "string"},
        "detail": {"type": "string"},
    },
}

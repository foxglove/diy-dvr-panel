"""Frame and timestamp helpers shared across the demo modules.

Deliberately small: Euler->quaternion in the SDK's Quaternion type and
Timestamp constructors. Harvested from the water-turbulence-sim experiments.
"""

import datetime
import math

from foxglove.messages import Quaternion, Timestamp

QuatTuple = tuple[float, float, float, float]  # (x, y, z, w)

IDENTITY_QUAT = Quaternion(x=0.0, y=0.0, z=0.0, w=1.0)


def euler_to_quat_tuple(roll: float, pitch: float, yaw: float) -> QuatTuple:
    """Roll-pitch-yaw (radians) -> (x, y, z, w) quaternion tuple."""
    r, p, y = roll * 0.5, pitch * 0.5, yaw * 0.5
    sr, cr = math.sin(r), math.cos(r)
    sp, cp = math.sin(p), math.cos(p)
    sy, cy = math.sin(y), math.cos(y)
    return (
        sr * cp * cy - cr * sp * sy,
        cr * sp * cy + sr * cp * sy,
        cr * cp * sy - sr * sp * cy,
        cr * cp * cy + sr * sp * sy,
    )


def yaw_to_quaternion(yaw: float) -> Quaternion:
    """Heading-only (radians about world z) -> SDK Quaternion."""
    return euler_to_quaternion(0.0, 0.0, yaw)


def euler_to_quaternion(roll: float, pitch: float, yaw: float) -> Quaternion:
    """Roll-pitch-yaw (radians) -> SDK Quaternion."""
    qx, qy, qz, qw = euler_to_quat_tuple(roll, pitch, yaw)
    return Quaternion(x=qx, y=qy, z=qz, w=qw)


def ts_from_seconds(sec: float) -> Timestamp:
    return Timestamp.from_datetime(
        datetime.datetime.fromtimestamp(sec, tz=datetime.timezone.utc)
    )


def ts_now() -> Timestamp:
    return Timestamp.from_datetime(datetime.datetime.now(tz=datetime.timezone.utc))

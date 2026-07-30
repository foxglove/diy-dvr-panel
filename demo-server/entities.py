"""Foxglove message builders for the 3D scene, pose, transform, and plan.

Frames:
- `map`       — fixed world; grid, goal, obstacles, pose, and plan live here.
- `base_link` — robot body; attached to `map` via the /tf transform each tick,
                so the body/heading primitives are static in their own frame.

Schema refs: https://docs.foxglove.dev/docs/visualization/message-schemas
"""

from __future__ import annotations

import math

from foxglove.messages import (
    ArrowPrimitive,
    Color,
    CubePrimitive,
    FrameTransform,
    Pose,
    PoseInFrame,
    PosesInFrame,
    SceneEntity,
    SceneUpdate,
    SpherePrimitive,
    TextPrimitive,
    Timestamp,
    Vector3,
)

from lib.geometry import IDENTITY_QUAT, yaw_to_quaternion
from robot import RobotState
from world import Waypoint

MAP_FRAME = "map"
BODY_FRAME = "base_link"

_BODY_COLOR = Color(r=0.20, g=0.55, b=0.95, a=1.0)
_HEADING_COLOR = Color(r=1.0, g=1.0, b=1.0, a=1.0)
_GOAL_COLOR = Color(r=0.25, g=0.85, b=0.35, a=0.9)
_OBSTACLE_COLOR = Color(r=0.95, g=0.35, b=0.15, a=0.9)
_LABEL_COLOR = Color(r=1.0, g=1.0, b=1.0, a=1.0)

# Body dimensions kept as plain floats — SDK Vector3 attributes aren't
# readable back, so compute the z offset from the constant, not `_BODY_SIZE.z`.
_BODY_L, _BODY_W, _BODY_H = 0.7, 0.5, 0.3
_BODY_SIZE = Vector3(x=_BODY_L, y=_BODY_W, z=_BODY_H)


def build_tf(state: RobotState, ts: Timestamp) -> FrameTransform:
    return FrameTransform(
        timestamp=ts,
        parent_frame_id=MAP_FRAME,
        child_frame_id=BODY_FRAME,
        translation=Vector3(x=state.x, y=state.y, z=0.0),
        rotation=yaw_to_quaternion(state.yaw),
    )


def build_pose(state: RobotState, ts: Timestamp) -> PoseInFrame:
    return PoseInFrame(
        timestamp=ts,
        frame_id=MAP_FRAME,
        pose=Pose(
            position=Vector3(x=state.x, y=state.y, z=0.0),
            orientation=yaw_to_quaternion(state.yaw),
        ),
    )


def build_robot_entity(ts: Timestamp) -> SceneEntity:
    """Robot body + heading arrow, static in `base_link`."""
    return SceneEntity(
        timestamp=ts,
        frame_id=BODY_FRAME,
        id="robot",
        cubes=[
            CubePrimitive(
                pose=Pose(position=Vector3(x=0.0, y=0.0, z=_BODY_H / 2), orientation=IDENTITY_QUAT),
                size=_BODY_SIZE,
                color=_BODY_COLOR,
            )
        ],
        arrows=[
            ArrowPrimitive(
                pose=Pose(position=Vector3(x=0.0, y=0.0, z=_BODY_H / 2), orientation=IDENTITY_QUAT),
                shaft_length=0.5,
                shaft_diameter=0.08,
                head_length=0.2,
                head_diameter=0.16,
                color=_HEADING_COLOR,
            )
        ],
    )


def build_goal_entity(goal: Waypoint, ts: Timestamp) -> SceneEntity:
    return SceneEntity(
        timestamp=ts,
        frame_id=MAP_FRAME,
        id="goal",
        spheres=[
            SpherePrimitive(
                pose=Pose(position=Vector3(x=goal.x, y=goal.y, z=0.15), orientation=IDENTITY_QUAT),
                size=Vector3(x=0.5, y=0.5, z=0.5),
                color=_GOAL_COLOR,
            )
        ],
        texts=[
            TextPrimitive(
                pose=Pose(position=Vector3(x=goal.x, y=goal.y, z=0.8), orientation=IDENTITY_QUAT),
                billboard=True,
                font_size=0.4,
                scale_invariant=False,
                color=_LABEL_COLOR,
                text=f"goal: {goal.name}",
            )
        ],
    )


def build_obstacles_entity(
    obstacles: list[tuple[float, float, float]], ts: Timestamp
) -> SceneEntity:
    """Detected/dynamic obstacles as cubes in `map`. Empty list clears them."""
    cubes = [
        CubePrimitive(
            pose=Pose(position=Vector3(x=x, y=y, z=0.25), orientation=IDENTITY_QUAT),
            size=Vector3(x=2 * r, y=2 * r, z=0.5),
            color=_OBSTACLE_COLOR,
        )
        for (x, y, r) in obstacles
    ]
    return SceneEntity(timestamp=ts, frame_id=MAP_FRAME, id="obstacles", cubes=cubes)


def build_plan(path: list[tuple[float, float]], ts: Timestamp) -> PosesInFrame:
    poses: list[Pose] = []
    for i, (x, y) in enumerate(path):
        nxt = path[min(i + 1, len(path) - 1)]
        heading = math.atan2(nxt[1] - y, nxt[0] - x) if nxt != (x, y) else 0.0
        poses.append(
            Pose(position=Vector3(x=x, y=y, z=0.05), orientation=yaw_to_quaternion(heading))
        )
    return PosesInFrame(timestamp=ts, frame_id=MAP_FRAME, poses=poses)

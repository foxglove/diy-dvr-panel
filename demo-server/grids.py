"""Build a foxglove.Grid from the uint8 costmap.

The costmap is row-major `(ROWS, COLS)` with row 0 at the world y-minimum, so
the grid pose sits at (MIN_X, MIN_Y) and the buffer streams out directly with
`tobytes()` (C-order === row-major, row 0 first).

Grid schema: https://docs.foxglove.dev/docs/visualization/message-schemas/grid
"""

from __future__ import annotations

import numpy as np
from foxglove.messages import (
    Grid,
    PackedElementField,
    PackedElementFieldNumericType,
    Pose,
    Timestamp,
    Vector2,
    Vector3,
)

from lib.geometry import IDENTITY_QUAT
from world import CELL, COLS, MIN_X, MIN_Y

FRAME = "map"


def build_grid(costmap: np.ndarray, timestamp: Timestamp) -> Grid:
    data = np.ascontiguousarray(costmap, dtype=np.uint8).tobytes()
    return Grid(
        timestamp=timestamp,
        frame_id=FRAME,
        pose=Pose(
            position=Vector3(x=MIN_X, y=MIN_Y, z=0.0),
            orientation=IDENTITY_QUAT,
        ),
        column_count=COLS,
        cell_size=Vector2(x=CELL, y=CELL),
        row_stride=COLS,  # 1 byte per cell
        cell_stride=1,
        fields=[
            PackedElementField(
                name="cost", offset=0, type=PackedElementFieldNumericType.Uint8
            )
        ],
        data=data,
    )

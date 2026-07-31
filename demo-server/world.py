"""Static factory floor: bounds, shelving racks, dock waypoints, and a costmap.

All geometry is synthetic and self-contained (a generic warehouse floor). The
costmap is a row-major uint8 grid in the `map` frame that both the planner
(A* obstacle test) and the `/map` Grid publisher consume.

Coordinate convention: `map` frame, +x right, +y up (ENU-style, z up). The
costmap origin (cell 0,0) sits at (MIN_X, MIN_Y); cell (col, row) spans
[MIN_X + col*CELL .. ] on x and [MIN_Y + row*CELL .. ] on y.
"""

from dataclasses import dataclass, field

import numpy as np

# Frame ids used across the demo; /tf publishes MAP_FRAME -> BODY_FRAME.
MAP_FRAME = "map"
BODY_FRAME = "base_link"

# ---- Floor extent (meters) ------------------------------------------------
MIN_X, MAX_X = 0.0, 20.0
MIN_Y, MAX_Y = 0.0, 16.0
CELL = 0.25  # meters per costmap cell

COLS = int(round((MAX_X - MIN_X) / CELL))  # 80
ROWS = int(round((MAX_Y - MIN_Y) / CELL))  # 64

# Cost values (uint8, 0..100 like a ROS costmap).
FREE = 0
INFLATION = 60  # near an obstacle: passable by A* only if nothing better
LETHAL = 100  # obstacle body: never traversable
BLOCK_THRESHOLD = 90  # A* treats cost >= this as impassable
INFLATION_RADIUS_M = 0.9  # how far lethal cost bleeds outward (robot half-width + margin)


@dataclass(frozen=True)
class Rect:
    """Axis-aligned obstacle footprint in world meters."""

    x0: float
    y0: float
    x1: float
    y1: float
    label: str = ""


# Three shelving racks, ~1.5 m wide, leaving ~3.5 m aisles the robot threads
# between as it drives dock-to-dock. Kept deliberately sparse so the scene reads
# cold; waypoints all sit in open space well clear of the inflation halos.
STATIC_OBSTACLES: tuple[Rect, ...] = (
    Rect(4.0, 3.0, 5.5, 9.0, "rack A"),
    Rect(9.0, 3.0, 10.5, 9.0, "rack B"),
    Rect(14.0, 3.0, 15.5, 9.0, "rack C"),
)


@dataclass(frozen=True)
class Waypoint:
    name: str
    x: float
    y: float


# Dock / station goals the robot cycles between. All sit in free aisle space.
WAYPOINTS: tuple[Waypoint, ...] = (
    Waypoint("inbound dock", 1.5, 1.5),
    Waypoint("pick station 1", 7.5, 10.5),
    Waypoint("pick station 2", 12.5, 1.5),
    Waypoint("outbound dock", 18.5, 1.5),
    Waypoint("QA bench", 2.0, 14.5),
    Waypoint("charging bay", 18.5, 14.5),
)


@dataclass
class World:
    """Immutable static floor plus a mutable dynamic-obstacle overlay.

    `static_cost` is baked once. `dynamic_cost` holds fault-injected blockers
    (e.g. a pallet dropped in an aisle); `costmap()` merges the two so the
    planner routes around whatever is currently present.
    """

    static_cost: np.ndarray
    dynamic_cost: np.ndarray = field(default_factory=lambda: np.zeros((ROWS, COLS), np.uint8))

    def costmap(self) -> np.ndarray:
        return np.maximum(self.static_cost, self.dynamic_cost)

    def clear_dynamic(self) -> None:
        self.dynamic_cost[:] = 0

    def add_dynamic_obstacle(self, x: float, y: float, radius: float) -> None:
        stamp_disc(self.dynamic_cost, x, y, radius, LETHAL)
        stamp_disc(self.dynamic_cost, x, y, radius + INFLATION_RADIUS_M, INFLATION, only_free=True)


# ---- world <-> cell conversions -------------------------------------------
def world_to_cell(x: float, y: float) -> tuple[int, int]:
    col = int((x - MIN_X) / CELL)
    row = int((y - MIN_Y) / CELL)
    return max(0, min(COLS - 1, col)), max(0, min(ROWS - 1, row))


def cell_to_world(col: int, row: int) -> tuple[float, float]:
    return MIN_X + (col + 0.5) * CELL, MIN_Y + (row + 0.5) * CELL


def in_bounds(x: float, y: float) -> bool:
    return MIN_X <= x <= MAX_X and MIN_Y <= y <= MAX_Y


def stamp_rect(cost: np.ndarray, rect: Rect, value: int) -> None:
    c0, r0 = world_to_cell(rect.x0, rect.y0)
    c1, r1 = world_to_cell(rect.x1, rect.y1)
    cost[r0 : r1 + 1, c0 : c1 + 1] = value


def stamp_disc(cost: np.ndarray, x: float, y: float, radius: float, value: int, *, only_free: bool = False) -> None:
    cc, cr = world_to_cell(x, y)
    rad_cells = int(np.ceil(radius / CELL))
    r_lo, r_hi = max(0, cr - rad_cells), min(ROWS - 1, cr + rad_cells)
    c_lo, c_hi = max(0, cc - rad_cells), min(COLS - 1, cc + rad_cells)
    for row in range(r_lo, r_hi + 1):
        for col in range(c_lo, c_hi + 1):
            wx, wy = cell_to_world(col, row)
            if (wx - x) ** 2 + (wy - y) ** 2 <= radius**2:
                if only_free and cost[row, col] != FREE:
                    continue
                cost[row, col] = value


def _inflate(cost: np.ndarray) -> np.ndarray:
    """Grow an INFLATION halo around every LETHAL cell (Chebyshev radius)."""
    out = cost.copy()
    rad = int(np.ceil(INFLATION_RADIUS_M / CELL))
    lethal_rows, lethal_cols = np.where(cost >= LETHAL)
    for r, c in zip(lethal_rows, lethal_cols):
        r_lo, r_hi = max(0, r - rad), min(ROWS - 1, r + rad)
        c_lo, c_hi = max(0, c - rad), min(COLS - 1, c + rad)
        block = out[r_lo : r_hi + 1, c_lo : c_hi + 1]
        block[block < INFLATION] = INFLATION
    return out


def build_world() -> World:
    static = np.zeros((ROWS, COLS), np.uint8)
    for rect in STATIC_OBSTACLES:
        stamp_rect(static, rect, LETHAL)
    return World(static_cost=_inflate(static))

"""Grid A* over the costmap, with line-of-sight path smoothing.

Produces a list of world-space waypoints from the robot's current position to
a goal, routing around static racks and any fault-injected blocker. Small
enough (a few thousand cells, 8-connected) to replan synchronously on the tick
that a goal changes or a recovery kicks in.
"""

import heapq
import math

import numpy as np

from world import (
    BLOCK_THRESHOLD,
    COLS,
    INFLATION,
    ROWS,
    cell_to_world,
    world_to_cell,
)

_NEIGHBORS = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)]

# A* step penalty per unit of normalized costmap cost, so the path holds aisle
# centerlines instead of grazing the inflated edges of obstacles.
CLEARANCE_PENALTY = 6.0


def _passable(cost: np.ndarray, col: int, row: int) -> bool:
    return 0 <= col < COLS and 0 <= row < ROWS and cost[row, col] < BLOCK_THRESHOLD


def _nearest_free(cost: np.ndarray, col: int, row: int) -> tuple[int, int]:
    """Spiral outward to the closest passable cell (handles a start/goal that
    landed inside an inflation halo)."""
    if _passable(cost, col, row):
        return col, row
    for radius in range(1, max(COLS, ROWS)):
        for dc in range(-radius, radius + 1):
            for dr in range(-radius, radius + 1):
                if max(abs(dc), abs(dr)) != radius:
                    continue
                if _passable(cost, col + dc, row + dr):
                    return col + dc, row + dr
    return col, row


def _line_clear(
    cost: np.ndarray,
    a: tuple[int, int],
    b: tuple[int, int],
    threshold: int,
) -> bool:
    """Bresenham line-of-sight test: every cell on the line has cost < threshold."""
    (c0, r0), (c1, r1) = a, b
    dc, dr = abs(c1 - c0), abs(r1 - r0)
    sc, sr = (1 if c0 < c1 else -1), (1 if r0 < r1 else -1)
    err = dc - dr
    while True:
        if not (0 <= c0 < COLS and 0 <= r0 < ROWS and cost[r0, c0] < threshold):
            return False
        if (c0, r0) == (c1, r1):
            return True
        e2 = 2 * err
        if e2 > -dr:
            err -= dr
            c0 += sc
        if e2 < dc:
            err += dc
            r0 += sr


def _smooth(cost: np.ndarray, cells: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """String-pulling: drop intermediate cells the robot can see past."""
    if len(cells) <= 2:
        return cells
    out = [cells[0]]
    anchor = 0
    for i in range(2, len(cells)):
        # Only shortcut through genuinely free space (cost < INFLATION); letting
        # a shortcut cross inflation cells would straighten the path back onto
        # the rack edge that A*'s clearance penalty just routed it around.
        if not _line_clear(cost, cells[anchor], cells[i], INFLATION):
            out.append(cells[i - 1])
            anchor = i - 1
    out.append(cells[-1])
    return out


def plan_path(
    cost: np.ndarray, start_xy: tuple[float, float], goal_xy: tuple[float, float]
) -> list[tuple[float, float]]:
    """A* from start to goal. Returns [] if unreachable."""
    start = _nearest_free(cost, *world_to_cell(*start_xy))
    goal = _nearest_free(cost, *world_to_cell(*goal_xy))
    if start == goal:
        return [start_xy, goal_xy]

    def h(c: tuple[int, int]) -> float:
        dc, dr = abs(c[0] - goal[0]), abs(c[1] - goal[1])
        # Octile distance (admissible for 8-connected grids).
        return (dc + dr) + (math.sqrt(2) - 2) * min(dc, dr)

    open_heap: list[tuple[float, tuple[int, int]]] = [(h(start), start)]
    came: dict[tuple[int, int], tuple[int, int]] = {}
    g: dict[tuple[int, int], float] = {start: 0.0}
    closed: set[tuple[int, int]] = set()

    while open_heap:
        _, cur = heapq.heappop(open_heap)
        if cur == goal:
            break
        if cur in closed:
            continue
        closed.add(cur)
        for dc, dr in _NEIGHBORS:
            nc, nr = cur[0] + dc, cur[1] + dr
            if not _passable(cost, nc, nr):
                continue
            # No diagonal corner-cutting: a diagonal step is only legal if both
            # orthogonal cells are clear, else the path squeezes through a rack
            # corner and the robot body clips the obstacle.
            if dc != 0 and dr != 0 and not (
                _passable(cost, cur[0] + dc, cur[1])
                and _passable(cost, cur[0], cur[1] + dr)
            ):
                continue
            step = math.hypot(dc, dr)
            # Strongly bias away from inflation halos so the path holds aisle
            # centerlines instead of grazing rack edges (a small penalty here
            # let the path hug obstacles and the robot body clipped them).
            step += (cost[nr, nc] / 100.0) * CLEARANCE_PENALTY
            ng = g[cur] + step
            nxt = (nc, nr)
            if ng < g.get(nxt, float("inf")):
                g[nxt] = ng
                came[nxt] = cur
                heapq.heappush(open_heap, (ng + h(nxt), nxt))

    if goal not in came and goal != start:
        return []

    cells = [goal]
    node = goal
    while node in came:
        node = came[node]
        cells.append(node)
    cells.reverse()

    cells = _smooth(cost, cells)
    world = [cell_to_world(c, r) for c, r in cells]
    # Anchor the ends to the true start/goal so the follower converges exactly.
    world[0] = start_xy
    world[-1] = goal_xy
    return world

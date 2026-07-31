"""Polyline helpers shared by the follower and the fault injector.

Both need the same primitive: project a point onto the planned path, then walk a
fixed arc-length forward along it. The follower uses it to place its pure-pursuit
carrot; the fault injector uses it to drop a blocker ahead of the robot. Keeping
one implementation is what guarantees the blocker lands where the robot is
actually heading (see the note in `faults._fire`).
"""

import math

Point = tuple[float, float]


def project_onto_path(path: list[Point], xy: Point) -> tuple[int, Point]:
    """Closest point on the polyline to `xy`: returns (segment index, foot point).

    Projects onto each segment (not just its vertices) so the walk below advances
    smoothly as the robot moves along a long segment.
    """
    px, py = xy
    best_i, best_pt, best_d = 0, path[0], float("inf")
    for i in range(len(path) - 1):
        ax, ay = path[i]
        bx, by = path[i + 1]
        dx, dy = bx - ax, by - ay
        seg2 = dx * dx + dy * dy
        t = 0.0 if seg2 < 1e-12 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg2))
        fx, fy = ax + dx * t, ay + dy * t
        d = (fx - px) ** 2 + (fy - py) ** 2
        if d < best_d:
            best_d, best_i, best_pt = d, i, (fx, fy)
    return best_i, best_pt


def advance_along_path(path: list[Point], xy: Point, distance: float) -> Point:
    """A point `distance` metres ahead of `xy`'s projection onto `path`.

    Returns the path end if less than `distance` remains, and `xy` itself if the
    path has fewer than two points (callers handle that fallback explicitly).
    """
    if len(path) < 2:
        return xy
    start, foot = project_onto_path(path, xy)
    remaining = distance
    ax, ay = foot
    for i in range(start, len(path) - 1):
        bx, by = path[i + 1]
        seg = math.hypot(bx - ax, by - ay)
        if seg >= remaining:
            if seg < 1e-9:
                return bx, by
            t = remaining / seg
            return ax + (bx - ax) * t, ay + (by - ay) * t
        remaining -= seg
        ax, ay = bx, by
    return path[-1]

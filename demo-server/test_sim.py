"""Headless self-test: step the Simulation in FAKE time (no ws server, no sleep).

Run with:  uv run python test_sim.py

Asserts the demo actually tells its story: a path plans between waypoints, the
robot moves, the battery drains while driving, a fault fires early, and the
mission visits both DRIVING and ERROR.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from main import Simulation
from planner import plan_path
from state_machine import LOW_BATTERY_PCT, State
from world import WAYPOINTS, build_world


def test_plan_path_between_waypoints() -> None:
    world = build_world()
    a = WAYPOINTS[0]  # inbound dock
    b = WAYPOINTS[3]  # outbound dock
    path = plan_path(world.costmap(), (a.x, a.y), (b.x, b.y))
    assert len(path) >= 2, f"expected a non-empty path, got {path!r}"
    assert path[0] == (a.x, a.y)
    assert path[-1] == (b.x, b.y)
    print(f"  plan_path {a.name} -> {b.name}: {len(path)} waypoints OK")


def test_sim_run() -> None:
    seed = 0
    rate_hz = 20.0
    sim = Simulation(seed=seed, rate_hz=rate_hz)
    dt = sim.dt

    start_xy = sim.robot.xy
    states_seen: set[State] = set()
    first_fault_at: float | None = None
    saw_nonempty_path = False

    # Battery must strictly decrease across any two consecutive driving ticks.
    prev_pct: float | None = None
    prev_driving = False
    battery_checks = 0

    ticks = int(30.0 * rate_hz)  # ~30 simulated seconds
    for i in range(ticks):
        now = i * dt
        sim.tick(now)  # raises on any bug

        states_seen.add(sim.mission.state)
        if sim.path:
            saw_nonempty_path = True
        if sim.last_event is not None and first_fault_at is None:
            first_fault_at = now

        driving = sim.mission.is_driving
        pct = sim.battery.percentage
        if driving and prev_driving:
            assert pct < prev_pct, (
                f"battery not strictly decreasing while driving at t={now:.2f}: "
                f"{prev_pct} -> {pct}"
            )
            battery_checks += 1
        prev_pct, prev_driving = pct, driving

    end_xy = sim.robot.xy

    assert saw_nonempty_path, "sim never produced a non-empty plan"
    assert end_xy != start_xy, f"robot never moved: {start_xy} -> {end_xy}"
    assert battery_checks > 0, "robot never drove two consecutive ticks"
    assert first_fault_at is not None, "no fault fired in 30 s"
    assert first_fault_at <= 25.0, f"first fault too late: t={first_fault_at:.2f}"
    assert State.DRIVING in states_seen, "mission never reached DRIVING"
    assert State.ERROR in states_seen, "mission never reached ERROR"

    print(f"  robot moved {start_xy} -> ({end_xy[0]:.2f}, {end_xy[1]:.2f}) OK")
    print(f"  battery drained to {sim.battery.percentage:.2f}% "
          f"({battery_checks} strict-decrease checks) OK")
    print(f"  first fault at t={first_fault_at:.2f}s OK")
    print(f"  states seen: {sorted(s.value for s in states_seen)} OK")


def test_low_battery_docks_and_recovers() -> None:
    """Regression: a low battery must dock -> charge -> resume, not dead-stick.

    Reproduces the freeze where the DRIVING low-battery check preempted docking,
    so the robot re-planned to the charger it was already on and never charged.
    """
    sim = Simulation(seed=0, rate_hz=20.0)
    sim.battery.percentage = 14.0  # below LOW -> must route to the charger
    dt = sim.dt

    states_seen: set[State] = set()
    positions: list[tuple[float, float]] = []
    for i in range(int(150.0 * 20.0)):  # 150 simulated seconds
        sim.tick(i * dt)
        states_seen.add(sim.mission.state)
        positions.append(sim.robot.xy)

    assert State.CHARGING in states_seen, "robot never docked/charged (dead-stick)"
    assert sim.battery.percentage > LOW_BATTERY_PCT, (
        f"battery never recovered: {sim.battery.percentage:.2f}%"
    )
    # Not frozen: meaningful travel over the final 10 s (it drove off after charging).
    tail = positions[-200:]
    disp = sum(math.dist(tail[j], tail[j + 1]) for j in range(len(tail) - 1))
    assert disp > 1.0, f"robot frozen after charging: {disp:.3f} m over last 10 s"

    print(f"  low battery -> docked, charged to {sim.battery.percentage:.1f}%, "
          f"resumed ({disp:.1f} m in last 10 s) OK")


def test_robot_stays_out_of_racks() -> None:
    """The robot's body must never overlap a static rack (LETHAL cost).

    Samples the robot footprint (not just its center) against the static
    costmap each tick, so corner-cutting that drives the body through a rack
    edge is caught even when the path itself stays clear.
    """
    from world import CELL, LETHAL, ROWS, COLS, world_to_cell

    sim = Simulation(seed=1, rate_hz=20.0)
    static = sim.world.static_cost
    # Robot is 0.7 x 0.5 m; check a disc covering its half-diagonal.
    footprint_cells = int(math.ceil(0.43 / CELL))

    worst = 0
    worst_xy: tuple[float, float] | None = None
    incursion_ticks = 0
    for i in range(int(180.0 * 20.0)):  # 3 simulated minutes
        sim.tick(i * sim.dt)
        col, row = world_to_cell(*sim.robot.xy)
        hit = 0
        for dr in range(-footprint_cells, footprint_cells + 1):
            for dc in range(-footprint_cells, footprint_cells + 1):
                r, c = row + dr, col + dc
                if 0 <= r < ROWS and 0 <= c < COLS:
                    hit = max(hit, int(static[r, c]))
        if hit > worst:
            worst, worst_xy = hit, sim.robot.xy
        if hit >= LETHAL:
            incursion_ticks += 1

    assert incursion_ticks == 0, (
        f"robot body overlapped a rack on {incursion_ticks} ticks; "
        f"worst static cost under footprint {worst} at {worst_xy}"
    )
    print(f"  robot body cleared all racks (worst footprint cost {worst}) OK")


def test_message_builders() -> None:
    """Construct + encode every Foxglove message from a stepped sim state.

    Catches SDK-construction bugs (wrong kwargs, unreadable attributes) without
    needing a live WebSocket server.
    """
    from entities import (
        build_goal_entity,
        build_obstacles_entity,
        build_plan,
        build_pose,
        build_robot_entity,
        build_tf,
    )
    from foxglove.messages import SceneUpdate
    from grids import build_grid
    from lib.geometry import ts_now
    from main import _build_odometry, _diagnostic_log

    sim = Simulation(seed=3, rate_hz=20.0)
    for i in range(60):  # drive a few seconds, then force a fault event
        sim.tick(i * sim.dt)
    ts = ts_now()

    msgs = [
        build_tf(sim.robot, ts),
        build_pose(sim.robot, ts),
        _build_odometry(sim.robot, ts),
        build_robot_entity(ts),
        build_goal_entity(sim.goal, ts),
        build_obstacles_entity([(5.0, 5.0, 0.5)], ts),
        build_plan(sim.path, ts),
        build_grid(sim.world.costmap(), ts),
        SceneUpdate(entities=[build_robot_entity(ts)]),
    ]
    for m in msgs:
        m.encode()  # raises if the message is malformed

    # A synthetic fault event must also build a Log.
    from faults import FaultEvent, FaultKind

    ev = FaultEvent(FaultKind.MOTOR_STALL, "test stall", "error")
    _diagnostic_log(ev, ts).encode()
    print(f"  built + encoded {len(msgs) + 1} Foxglove messages OK")


def main() -> None:
    test_plan_path_between_waypoints()
    test_sim_run()
    test_low_battery_docks_and_recovers()
    test_robot_stays_out_of_racks()
    test_message_builders()
    print("ALL TESTS PASSED")


if __name__ == "__main__":
    main()

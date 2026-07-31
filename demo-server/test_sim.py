"""Headless self-test: step the Simulation in FAKE time (no ws server, no sleep).

Run with:  uv run python test_sim.py

Asserts the demo actually tells its story: a path plans between waypoints, the
robot moves, the battery drains while driving, a fault fires early, and the
mission visits both DRIVING and ERROR.
"""

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
    assert State.GOAL_REACHED in states_seen, "mission never completed a goal"

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


def test_obstacle_blocking_lands_ahead_of_robot() -> None:
    """Regression: the blocker drops ahead of the ROBOT, not the path start.

    The old bug walked from `path[0]`, so with the robot most of the way down a
    path the blocker landed far behind it and the "route around it" beat never
    happened.
    """
    import random

    from faults import BLOCKER_AHEAD_M, FaultContext, FaultInjector, FaultKind

    inj = FaultInjector(random.Random(0), start_time=0.0)
    path = [(0.0, 0.0), (10.0, 0.0)]  # straight 10 m path
    robot_xy = (6.0, 0.0)  # robot is 6 m along it, well past the start
    inj._fire(FaultKind.OBSTACLE_BLOCKING, FaultContext(0.0, robot_xy, 0.0, path))
    bx, by, _ = inj.pert.blocker

    assert abs(bx - (robot_xy[0] + BLOCKER_AHEAD_M)) < 1e-6, f"blocker x={bx}"
    assert abs(by) < 1e-6
    # The old placement would sit ~BLOCKER_AHEAD_M from path[0]; guard against it.
    assert math.hypot(bx - path[0][0], by - path[0][1]) > BLOCKER_AHEAD_M
    print("  obstacle_blocking lands ahead of the robot, not the path start OK")


def test_motor_stall_is_warning_and_decelerates() -> None:
    """Regression: motor_stall's speed_scale actually slows the follower.

    It was dead: motor_stall tripped ERROR, so the robot wasn't driving and never
    read speed_scale. It's now a warning that decelerates the follower to a stop.
    """
    import random

    from faults import FaultContext, FaultInjector, FaultKind
    from robot import RobotState, step

    inj = FaultInjector(random.Random(0), start_time=0.0)
    ev = inj._fire(FaultKind.MOTOR_STALL, FaultContext(0.0, (0.0, 0.0), 0.0, [(0.0, 0.0), (10.0, 0.0)]))
    assert ev.level == "warning", f"motor_stall level {ev.level!r}"
    assert inj.pert.speed_scale == 0.0

    st = RobotState(x=2.0, y=0.0, yaw=0.0, v=1.2, w=0.0)
    for _ in range(100):
        st, _ = step(st, [(0.0, 0.0), (10.0, 0.0)], 0.05, speed_scale=0.0)
    assert st.v < 0.05, f"stall did not decelerate the follower: v={st.v}"
    print("  motor_stall is a warning that decelerates the follower OK")


def test_plan_path_returns_empty_when_unreachable() -> None:
    """A goal walled off from the start yields no path (not a corner-squeeze)."""
    import numpy as np

    from planner import plan_path
    from world import CELL, COLS, LETHAL, MIN_X, MIN_Y, ROWS

    cost = np.zeros((ROWS, COLS), np.uint8)
    cost[:, COLS // 2] = LETHAL  # full-height wall splits the floor
    left = (MIN_X + 2 * CELL, MIN_Y + 2 * CELL)
    right = (MIN_X + (COLS - 2) * CELL, MIN_Y + 2 * CELL)
    assert plan_path(cost, left, right) == [], "expected no path across a solid wall"
    print("  plan_path returns [] across a full-height wall OK")


def test_unreachable_goal_does_not_deadstick() -> None:
    """Regression: an empty plan must not park the robot in DRIVING forever.

    With half the floor walled off, some waypoints are unreachable; the mission
    must bail to recovery rather than sit in DRIVING on an empty path.
    """
    from state_machine import State
    from world import COLS, LETHAL

    sim = Simulation(seed=0, rate_hz=20.0)
    # Wall the *static* cost (dynamic cost is wiped on every GOAL_REACHED), so
    # the right-half waypoints stay unreachable for the whole run.
    sim.world.static_cost[:, COLS // 2] = LETHAL

    saw_recovery = False
    for i in range(int(60.0 * 20.0)):
        sim.tick(i * sim.dt)
        if sim.mission.is_driving:
            assert sim.path, f"driving with an empty path at tick {i} (dead-stick)"
        if sim.mission.state in (State.ERROR, State.RECOVERING):
            saw_recovery = True

    assert saw_recovery, "expected ERROR/RECOVERING when a goal is unreachable"
    print("  unreachable goal recovers instead of dead-sticking in DRIVING OK")


def test_odom_twist_zero_when_not_driving() -> None:
    """Regression: body twist is zeroed whenever the robot isn't driving.

    Odom used to keep publishing the last driving velocity while the pose was
    frozen in ERROR, so twist and pose disagreed during an incident.
    """
    saw_stopped = False
    sim = Simulation(seed=0, rate_hz=20.0)
    for i in range(int(120.0 * 20.0)):
        sim.tick(i * sim.dt)
        if not sim.mission.is_driving:
            assert sim.robot.v == 0.0 and sim.robot.w == 0.0, (
                f"nonzero twist while not driving at tick {i}: "
                f"v={sim.robot.v}, w={sim.robot.w}"
            )
            saw_stopped = True
    assert saw_stopped, "never observed a non-driving tick"
    print("  /odom twist is zero whenever the robot is not driving OK")


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
    test_obstacle_blocking_lands_ahead_of_robot()
    test_motor_stall_is_warning_and_decelerates()
    test_plan_path_returns_empty_when_unreachable()
    test_unreachable_goal_does_not_deadstick()
    test_odom_twist_zero_when_not_driving()
    test_message_builders()
    print("ALL TESTS PASSED")


if __name__ == "__main__":
    main()

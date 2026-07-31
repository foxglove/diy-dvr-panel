"""Factory-nav demo server: a warehouse robot driving dock-to-dock.

The robot A*-plans around static racks, follows the plan with pure-pursuit, and
hits a random fault ("the issue") every 5-20 s that trips it into ERROR. Streams
map / plan / pose / tf / scene / odom / imu / battery / status / diagnostics so
the DIY DVR panel can capture the window around an incident.

The tick logic lives in `Simulation` (pure: no networking, no wallclock), so a
headless self-test can step it in fake time. `run()` wraps it with the Foxglove
WebSocket publish layer.

Usage:
    uv run python main.py [--rate-hz 20] [--seed 0]

Foxglove SDK reference: https://docs.foxglove.dev/docs/sdk
"""

import logging
import random
import sys
import time
from dataclasses import dataclass, field, replace
from pathlib import Path

# Ensure sibling modules + `lib.geometry` resolve regardless of the cwd used to
# launch the server.
sys.path.insert(0, str(Path(__file__).resolve().parent))

import foxglove
from foxglove import Channel
from foxglove.messages import (
    Log,
    LogLevel,
    Odometry,
    Pose,
    SceneUpdate,
    Vector3,
)
from foxglove.websocket import Capability

from cli import parse_args
from entities import (
    build_goal_entity,
    build_obstacles_entity,
    build_plan,
    build_pose,
    build_robot_entity,
    build_tf,
)
from faults import FaultContext, FaultEvent, FaultInjector
from grids import build_grid
from lib.geometry import ts_now, yaw_to_quaternion
from robot import RobotState
from robot import step as robot_step
from schemas import BATTERY_SCHEMA, IMU_SCHEMA, STATUS_SCHEMA
from sensors import Battery, imu_reading
from state_machine import LOW_BATTERY_PCT, Mission, State
from world import BODY_FRAME, MAP_FRAME, WAYPOINTS, Waypoint, World, build_world
from planner import plan_path

CHARGING_BAY = "charging bay"
MAP_PUBLISH_PERIOD_S = 1.0


@dataclass
class Simulation:
    """Pure simulation state + a single-tick advance in fake time.

    Owns the world, robot, mission, battery, and fault injector. `tick(now)`
    advances everything by `dt` and updates the message-ready fields (`imu`,
    `battery_msg`, `last_event`, ...). No Foxglove or wallclock calls here.
    """

    seed: int = 0
    rate_hz: float = 20.0

    # Populated in __post_init__.
    dt: float = field(init=False)
    world: World = field(init=False)
    injector: FaultInjector = field(init=False)
    mission: Mission = field(init=False)
    battery: Battery = field(init=False)
    robot: RobotState = field(init=False)
    goal: Waypoint = field(init=False)
    goal_index: int = field(init=False)
    path: list[tuple[float, float]] = field(init=False)
    prev_v: float = field(init=False)
    at_goal: bool = field(init=False)
    at_charger: bool = field(init=False)
    dynamic_obstacles: list[tuple[float, float, float]] = field(init=False)
    last_event: FaultEvent | None = field(init=False)
    imu: dict[str, object] = field(init=False)
    battery_msg: dict[str, object] = field(init=False)
    _prev_state: State = field(init=False)

    def __post_init__(self) -> None:
        self.dt = 1.0 / self.rate_hz
        self.world = build_world()
        # Separate RNGs so sensor noise never perturbs fault scheduling.
        self._fault_rng = random.Random(self.seed)
        self._sensor_rng = random.Random(self.seed + 1)
        self.injector = FaultInjector(self._fault_rng, start_time=0.0)
        self.mission = Mission()
        self.battery = Battery()

        start = WAYPOINTS[0]  # inbound dock
        self.robot = RobotState(x=start.x, y=start.y, yaw=0.0)
        self.goal = start  # first pick_goal() will move on (it skips current)
        self.goal_index = 0
        self.path = []

        self.prev_v = 0.0
        self.at_goal = False
        self.at_charger = False
        self.dynamic_obstacles = []
        self.last_event = None
        self._prev_state = self.mission.state

        # Message-ready sensor snapshots.
        self.imu = {}
        self.battery_msg = {}

    def _pick_goal(self, battery_pct: float) -> Waypoint:
        """Next goal: charging bay when low, else cycle waypoints (skip current)."""
        if battery_pct <= LOW_BATTERY_PCT:
            for i, wp in enumerate(WAYPOINTS):
                if wp.name == CHARGING_BAY:
                    self.goal_index = i
                    return wp
        for _ in range(len(WAYPOINTS)):
            self.goal_index = (self.goal_index + 1) % len(WAYPOINTS)
            if WAYPOINTS[self.goal_index].name != self.goal.name:
                return WAYPOINTS[self.goal_index]
        return WAYPOINTS[self.goal_index]

    def tick(self, now: float) -> None:
        dt = self.dt

        # 1. Fault injector.
        ctx = FaultContext(
            now=now,
            robot_xy=self.robot.xy,
            robot_yaw=self.robot.yaw,
            path=self.path,
        )
        event = self.injector.update(ctx)
        # Only error-level faults (a blocking obstacle) trip the mission into
        # ERROR and force a replan. Warning-level faults (motor stall, IMU tilt,
        # battery sag, pose jump) perturb the live signals while the robot keeps
        # driving, so each shows a distinct on-screen effect.
        if event is not None and event.level == "error":
            self.mission.trip_fault(event.message)
        self.last_event = event

        # 2. Apply perturbations.
        pert = self.injector.pert
        if pert.loc_jump is not None:
            dx, dy = pert.loc_jump
            self.robot = RobotState(
                self.robot.x + dx, self.robot.y + dy, self.robot.yaw,
                v=self.robot.v, w=self.robot.w,
            )
            pert.loc_jump = None
        if pert.blocker is not None:
            bx, by, br = pert.blocker
            self.world.add_dynamic_obstacle(bx, by, br)
            self.dynamic_obstacles.append((bx, by, br))
            pert.blocker = None

        # 3. Mission state machine (reads last tick's outcome).
        battery_pct = self.battery.percentage
        self.mission.update(
            dt,
            at_goal=self.at_goal,
            battery_pct=battery_pct,
            at_charger=self.at_charger,
        )

        # Clear the fault-dropped blocker once a goal is reached (issue cleared).
        if (
            self.mission.state is State.GOAL_REACHED
            and self._prev_state is not State.GOAL_REACHED
        ):
            self.world.clear_dynamic()
            self.dynamic_obstacles.clear()

        # 4. Plan on entering PLANNING (also the obstacle-forced replan path,
        #    since a blocker trips ERROR -> RECOVERING -> PLANNING).
        if self.mission.is_planning:
            self.goal = self._pick_goal(battery_pct)
            self.path = plan_path(
                self.world.costmap(), self.robot.xy, (self.goal.x, self.goal.y)
            )
            self.at_goal = False
            self.at_charger = False
            if self.path:
                self.mission.start_driving(f"en route to {self.goal.name}")
            else:
                # No route to this goal — bail to ERROR so RECOVERING re-picks
                # another, instead of dead-sticking in DRIVING on an empty path.
                self.mission.trip_fault(f"no route to {self.goal.name}")

        # 5. Drive.
        self.prev_v = self.robot.v
        if self.mission.is_driving:
            self.robot, reached = robot_step(
                self.robot, self.path, dt, speed_scale=pert.speed_scale
            )
            self.at_goal = reached
            self.at_charger = reached and self.goal.name == CHARGING_BAY
        else:
            # Parked in a non-driving state: zero the body twist so /odom agrees
            # with the frozen pose instead of reporting the last driving velocity.
            self.robot = replace(self.robot, v=0.0, w=0.0)

        # 6. Sensors.
        self.imu = imu_reading(
            self.robot,
            self.prev_v,
            dt,
            self._sensor_rng,
            tilt_spike=pert.tilt_spike,
            accel_spike=pert.accel_spike,
        )
        self.battery_msg = self.battery.step(
            dt,
            moving=self.mission.is_driving,
            charging=self.mission.state is State.CHARGING,
            sag=pert.battery_sag,
        )

        self._prev_state = self.mission.state


def _build_odometry(state: RobotState, ts) -> Odometry:
    return Odometry(
        timestamp=ts,
        frame_id=MAP_FRAME,
        body_frame_id=BODY_FRAME,
        pose=Pose(
            position=Vector3(x=state.x, y=state.y, z=0.0),
            orientation=yaw_to_quaternion(state.yaw),
        ),
        linear_velocity=Vector3(x=state.v, y=0.0, z=0.0),
        angular_velocity=Vector3(x=0.0, y=0.0, z=state.w),
    )


def _diagnostic_log(event: FaultEvent, ts) -> Log:
    level = LogLevel.Error if event.level == "error" else LogLevel.Warning
    return Log(
        timestamp=ts,
        level=level,
        message=event.message,
        name=event.kind.value,
        file="faults.py",
        line=0,
    )


def run(rate_hz: float, host: str, port: int, seed: int) -> None:
    # See: https://docs.foxglove.dev/docs/sdk/python/quickstart
    server = foxglove.start_server(
        host=host, port=port, capabilities=[Capability.ClientPublish]
    )
    logging.info("Foxglove WS server listening — connect to ws://%s:%d", host, port)

    # Explicit JSON-schema channels so Plot / State Transitions address fields.
    imu_chan = Channel(topic="/imu", schema=IMU_SCHEMA)
    battery_chan = Channel(topic="/battery", schema=BATTERY_SCHEMA)
    status_chan = Channel(topic="/status", schema=STATUS_SCHEMA)

    sim = Simulation(seed=seed, rate_hz=rate_hz)
    period = 1.0 / rate_hz
    start = time.time()
    last_map = -1e9

    try:
        while True:
            tick_start = time.time()
            now = tick_start - start
            sim.tick(now)
            ts = ts_now()

            foxglove.log("/tf", build_tf(sim.robot, ts))
            foxglove.log("/robot/pose", build_pose(sim.robot, ts))
            foxglove.log("/odom", _build_odometry(sim.robot, ts))
            foxglove.log(
                "/scene",
                SceneUpdate(
                    entities=[
                        build_robot_entity(ts),
                        build_goal_entity(sim.goal, ts),
                        build_obstacles_entity(sim.dynamic_obstacles, ts),
                    ]
                ),
            )
            foxglove.log("/plan", build_plan(sim.path, ts))
            if now - last_map >= MAP_PUBLISH_PERIOD_S:
                foxglove.log("/map", build_grid(sim.world.costmap(), ts))
                last_map = now

            imu_chan.log(sim.imu)
            battery_chan.log(sim.battery_msg)
            status_chan.log(
                {"state": sim.mission.state.value, "detail": sim.mission.detail}
            )

            if sim.last_event is not None:
                foxglove.log("/diagnostics", _diagnostic_log(sim.last_event, ts))

            elapsed = time.time() - tick_start
            if elapsed < period:
                time.sleep(period - elapsed)
    except KeyboardInterrupt:
        pass
    finally:
        server.stop()


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    foxglove.set_log_level(logging.INFO)
    args = parse_args()
    run(args.rate_hz, args.host, args.port, args.seed)


if __name__ == "__main__":
    main()

"""Mission state machine driving the State Transitions panel.

States (published as the string `state` on /status):

    IDLE -> PLANNING -> DRIVING -> GOAL_REACHED -> PLANNING -> ...
    DRIVING -> ERROR -> RECOVERING -> PLANNING          (fault path)
    (battery low) -> ... -> CHARGING -> PLANNING

The machine owns only the discrete mode + timers; the main loop reads
`state` each tick and decides motion. Keeping transitions in one place makes
the State Transitions panel legible when read cold.
"""

from enum import Enum


class State(str, Enum):
    IDLE = "IDLE"
    PLANNING = "PLANNING"
    DRIVING = "DRIVING"
    ERROR = "ERROR"
    RECOVERING = "RECOVERING"
    GOAL_REACHED = "GOAL_REACHED"
    CHARGING = "CHARGING"


# How long the machine dwells in each transient state before moving on.
GOAL_DWELL_S = 1.5
ERROR_DWELL_S = 1.2
RECOVER_DWELL_S = 1.5
CHARGE_TARGET_PCT = 90.0
LOW_BATTERY_PCT = 15.0


class Mission:
    def __init__(self) -> None:
        self.state = State.IDLE
        self._since = 0.0  # seconds spent in the current state
        self.detail = "startup"

    def _to(self, state: State, detail: str) -> None:
        self.state = state
        self.detail = detail
        self._since = 0.0

    def trip_fault(self, message: str) -> None:
        """Called by the fault injector: drop into ERROR from any driving state."""
        if self.state in (State.DRIVING, State.PLANNING):
            self._to(State.ERROR, message)

    def update(self, dt: float, *, at_goal: bool, battery_pct: float, at_charger: bool) -> None:
        self._since += dt

        if self.state is State.IDLE:
            self._to(State.PLANNING, "selecting goal")

        elif self.state is State.PLANNING:
            # main loop flips us to DRIVING once a path exists (see arrived()).
            pass

        elif self.state is State.DRIVING:
            # Dock first: if we've arrived at the charger, charge before anything
            # else. Checking low-battery ahead of this would loop us back into
            # PLANNING -> (re-pick the charger we're already on) and never dock.
            if at_charger and battery_pct < CHARGE_TARGET_PCT:
                self._to(State.CHARGING, "docked, charging")
            elif at_goal:
                self._to(State.GOAL_REACHED, "goal reached")
            elif battery_pct <= LOW_BATTERY_PCT:
                self._to(State.PLANNING, "battery low, routing to charger")

        elif self.state is State.GOAL_REACHED:
            if at_charger and battery_pct < CHARGE_TARGET_PCT:
                self._to(State.CHARGING, "docked, charging")
            elif self._since >= GOAL_DWELL_S:
                self._to(State.PLANNING, "selecting next goal")

        elif self.state is State.ERROR:
            if self._since >= ERROR_DWELL_S:
                self._to(State.RECOVERING, "clearing fault")

        elif self.state is State.RECOVERING:
            if self._since >= RECOVER_DWELL_S:
                self._to(State.PLANNING, "replanning around issue")

        elif self.state is State.CHARGING:
            if battery_pct >= CHARGE_TARGET_PCT:
                self._to(State.PLANNING, "charged, selecting goal")

    def start_driving(self, detail: str = "en route") -> None:
        if self.state is State.PLANNING:
            self._to(State.DRIVING, detail)

    @property
    def is_planning(self) -> bool:
        return self.state is State.PLANNING

    @property
    def is_driving(self) -> bool:
        return self.state is State.DRIVING

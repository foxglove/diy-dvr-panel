#!/usr/bin/env bash
# Start/stop wrapper for the factory-nav demo server (single-directory layout).
#
# Usage:
#   ./serve.sh                       # start the server (foreground-detached)
#   ./serve.sh start [-- args...]    # same; pass extra flags after `start`
#   ./serve.sh restart [-- args...]  # alias for start
#   ./serve.sh stop                  # kill whatever's on the port
#   ./serve.sh status                # show running server (if any)
#   ./serve.sh logs                  # tail the most recent log
set -euo pipefail

PORT=8765
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$SCRIPT_DIR/.logs"
LOG_FILE="$LOG_DIR/demo-server.log"
PID_FILE="$LOG_DIR/demo-server.pid"
mkdir -p "$LOG_DIR"

usage() {
    echo "Usage: $0 {start|restart|stop|status|logs} [-- extra args]"
}

current_pid() {
    # Only PIDs LISTENING on $PORT — not processes with an outbound socket
    # whose local ephemeral port happens to be $PORT (Chrome, etc).
    lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null || true
}

stop_server() {
    local pids
    pids=$(current_pid)
    if [[ -z "$pids" ]]; then
        echo "No server on port $PORT."
        return 0
    fi
    echo "Stopping process(es) on port $PORT: $pids"
    kill $pids 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8; do
        sleep 0.25
        if [[ -z "$(current_pid)" ]]; then
            echo "Stopped."
            return 0
        fi
    done
    echo "Force-killing..."
    kill -9 $pids 2>/dev/null || true
    sleep 0.25
}

status_server() {
    local pids
    pids=$(current_pid)
    if [[ -z "$pids" ]]; then
        echo "No server on port $PORT."
        return 1
    fi
    for pid in $pids; do
        ps -p "$pid" -o pid=,user=,etime=,command= || true
    done
}

start_server() {
    stop_server
    if [[ $# -gt 0 ]]; then
        echo "Starting demo-server — logs: $LOG_FILE — args: $*"
    else
        echo "Starting demo-server — logs: $LOG_FILE"
    fi
    (
        cd "$SCRIPT_DIR"
        nohup uv run python main.py "$@" >"$LOG_FILE" 2>&1 &
        echo $! >"$PID_FILE"
        disown 2>/dev/null || true
    )
    sleep 1
    if status_server; then
        echo "Up. Connect Foxglove to ws://localhost:$PORT"
    else
        echo "Failed to start — check $LOG_FILE" >&2
        tail -n 20 "$LOG_FILE" >&2 || true
        exit 1
    fi
}

tail_logs() {
    if [[ -f "$LOG_FILE" ]]; then
        tail -n 50 "$LOG_FILE"
    else
        echo "No logs yet." >&2
        return 1
    fi
}

cmd="${1:-start}"
case "$cmd" in
    start | restart)
        shift || true
        # Drop a leading `--` separator if present.
        [[ "${1:-}" == "--" ]] && shift || true
        start_server "$@"
        ;;
    stop)
        stop_server
        ;;
    status)
        status_server || true
        ;;
    logs)
        tail_logs
        ;;
    -h | --help)
        usage
        ;;
    *)
        usage
        exit 1
        ;;
esac

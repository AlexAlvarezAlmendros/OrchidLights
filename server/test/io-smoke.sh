#!/bin/bash
#
# F17's I/O depth: one universe feeding two lines at once, plugin knobs that
# stick, the engine's own metronome, chasers that follow it, and an input
# profile editor that writes .qxi files QLC+ would load.
#
#   server/test/io-smoke.sh [path-to-orchidlightsd]
#
# The daemon runs with HOME pointed at the workdir so the profiles it writes
# land in the sandbox, not in the operator's real ~/.orchidlights.

set -euo pipefail

DAEMON=${1:-orchidlightsd}
PORT=${PORT:-9949}
HERE=$(cd "$(dirname "$0")" && pwd)

export QT_QPA_PLATFORM=offscreen

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/" 2>/dev/null; then
    fail "something is already listening on port $PORT; set PORT= to another one"
fi

WORK=$(mktemp -d)
read -r -a EXTRA <<< "${ORCHID_TEST_ARGS:-}"

# NOT --no-output: the loopback lives among the output plugins, and this whole
# smoke is about wires.
HOME="$WORK" "$DAEMON" --port "$PORT" --projects "$WORK" \
    "${EXTRA[@]+"${EXTRA[@]}"}" > "$WORK/daemon.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; rm -rf "$WORK"' EXIT

for _ in $(seq 1 100); do
    curl -sf --max-time 1 "http://127.0.0.1:$PORT/api/v1/status" > /dev/null 2>&1 && break
    kill -0 $PID 2>/dev/null || { cat "$WORK/daemon.log" >&2; fail "the daemon exited early"; }
    sleep 0.2
done

node "$HERE/io-client.mjs" "http://127.0.0.1:$PORT" "ws://127.0.0.1:$PORT/ws" "$WORK" \
    || fail "the I/O depth did not do what it says"

echo "I/O smoke test passed."

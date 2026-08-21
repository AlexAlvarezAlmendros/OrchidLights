#!/bin/bash
#
# External input made to act, without a single piece of hardware.
#
#   server/test/input-smoke.sh [path-to-orchidlightsd]
#
# The loopback plugin closes the circuit: universe B's output feeds its own
# input, so the engine's own wire plays the MIDI wing. A button binding fires
# a scene on universe A and the proof is A's DMX; the grand master binding
# dims it; feedback comes back on a second loop and the saved .qxw carries
# every binding.

set -euo pipefail

DAEMON=${1:-orchidlightsd}
PORT=${PORT:-9947}
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

# NOT --no-output: the loopback lives among the output plugins, and a daemon
# without them has no wire to close.
"$DAEMON" --port "$PORT" --projects "$WORK" \
    "${EXTRA[@]+"${EXTRA[@]}"}" > "$WORK/daemon.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; rm -rf "$WORK"' EXIT

for _ in $(seq 1 100); do
    curl -sf --max-time 1 "http://127.0.0.1:$PORT/api/v1/status" > /dev/null 2>&1 && break
    kill -0 $PID 2>/dev/null || { cat "$WORK/daemon.log" >&2; fail "the daemon exited early"; }
    sleep 0.2
done

node "$HERE/input-client.mjs" "http://127.0.0.1:$PORT" "ws://127.0.0.1:$PORT/ws" \
    "$WORK/bound.qxw" || fail "external input did not do what it says"

echo "Input smoke test passed."

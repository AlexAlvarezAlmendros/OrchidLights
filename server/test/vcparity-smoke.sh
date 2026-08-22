#!/bin/bash
#
# F14b's console depth: side faders and multipage frames, on the wire.
#
#   server/test/vcparity-smoke.sh [path-to-orchidlightsd]
#
# The cue list's Steps fader maps onto the cue list, Crossfade BLENDS the
# running cue with the next (measured mid-travel at half/half), and a
# multipage frame's page turns from external input through the loopback --
# wall without PagesLoop, wrap with it. The .qxw carries XML QLC+ 5 loads.

set -euo pipefail

DAEMON=${1:-orchidlightsd}
PORT=${PORT:-9931}
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

node "$HERE/vcparity-client.mjs" "http://127.0.0.1:$PORT" "ws://127.0.0.1:$PORT/ws" \
    "$WORK/paridad.qxw" || fail "the console depth did not do what it says"

echo "VC parity smoke test passed."

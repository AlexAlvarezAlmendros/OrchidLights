#!/bin/bash
#
# An XY pad, and the DMX it actually produces.
#
#   server/test/xypad-smoke.sh [path-to-orchidlightsd] [path-to-project.qxw]
#
# Everything else about a pad can work while no light moves: the position parks
# under a mutex, echoes to the other clients and reads back correctly whether or
# not it ever reaches a channel. So this one reads the universe.
#
# Needs Node 22 or newer for its built-in WebSocket.

set -euo pipefail

DAEMON=${1:-orchidlightsd}
PROJECT=${2:-server/test/data/xypad.qxw}
PORT=${PORT:-9984}
HERE=$(cd "$(dirname "$0")" && pwd)

export QT_QPA_PLATFORM=offscreen

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

# A daemon already on this port would answer every request below, and the test
# would pass or fail against a project nobody chose. Cheap to check, and it has
# already cost one confusing failure.
if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/" 2>/dev/null; then
    fail "something is already listening on port $PORT; set PORT= to another one"
fi

"$DAEMON" --port "$PORT" --no-output "$PROJECT" > /tmp/orchid-xypad.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT

for _ in $(seq 1 100); do
    curl -sf --max-time 1 "http://127.0.0.1:$PORT/api/v1/status" > /dev/null 2>&1 && break
    kill -0 $PID 2>/dev/null || { cat /tmp/orchid-xypad.log >&2; fail "the daemon exited early"; }
    sleep 0.2
done

# The pad has to come back as steerable before there is any point in aiming it.
curl -sf --max-time 5 "http://127.0.0.1:$PORT/api/v1/vc" | python3 -c '
import json, sys
def walk(w):
    yield w
    for c in w.get("children", []):
        yield from walk(c)
pads = [w for w in walk(json.load(sys.stdin)) if w.get("type") == "xypad"]
assert pads, "the project has no XY pad"
pad = pads[0]
assert pad["padHeads"] == 3, pad
assert pad["controllable"] is True, pad
' || fail "GET /vc did not report a steerable pad"

# Loopback with no --require-auth needs no token, but pass one when there is a
# file, so this runs the same way as the other feed tests.
TOKEN=$(cat "$HOME/.orchidlights/api-token" 2>/dev/null || echo "")

node "$HERE/xypad-client.mjs" "ws://127.0.0.1:$PORT/ws" "$TOKEN" \
    || fail "the pad did not put the expected values on the universe"

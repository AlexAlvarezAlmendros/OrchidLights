#!/bin/bash
#
# An Frames: nested, paged, and solo.
#
#   server/test/frames-smoke.sh [path-to-orchidlightsd] [path-to-project.qxw]
#
# Everything else about a pad can work while no light moves: the position parks
# under a mutex, echoes to the other clients and reads back correctly whether or
# not it ever reaches a channel. So this one reads the universe.
#
# Needs Node 22 or newer for its built-in WebSocket.

set -euo pipefail

DAEMON=${1:-orchidlightsd}
PROJECT=${2:-server/test/data/vc-frames.qxw}
PORT=${PORT:-9982}
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

"$DAEMON" --port "$PORT" --no-output "$PROJECT" > /tmp/orchid-frames.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT

for _ in $(seq 1 100); do
    curl -sf --max-time 1 "http://127.0.0.1:$PORT/api/v1/status" > /dev/null 2>&1 && break
    kill -0 $PID 2>/dev/null || { cat /tmp/orchid-frames.log >&2; fail "the daemon exited early"; }
    sleep 0.2
done

# The tree the interface is handed: frames nested inside frames, a solo one,
# and a paged one whose children name their page.
curl -sf --max-time 5 "http://127.0.0.1:$PORT/api/v1/vc" | python3 -c '
import json, sys
def walk(w):
    yield w
    for c in w.get("children", []):
        yield from walk(c)

widgets = {w["id"]: w for w in walk(json.load(sys.stdin)) if "id" in w}

solo = widgets[1]
assert solo["type"] == "soloframe", solo
assert len(solo["children"]) == 3, "a frame that reports no children is a frame nobody can see"

paged = widgets[7]
assert paged["pages"] == 2, paged

# A page is written only when it is not the first, so this is also the check
# that an absent Page is not read as something else.
assert widgets[8].get("page", 0) == 0, widgets[8]
assert widgets[9]["page"] == 1, widgets[9]

# A playback slider is movable: there is a function behind it. Reporting it as
# not would leave a control greyed out that works perfectly.
playback = widgets[10]
assert playback["sliderMode"] == "playback", playback
assert playback["controllable"] is True, playback
' || fail "GET /vc did not describe the frames"

# Loopback with no --require-auth needs no token, but pass one when there is a
# file, so this runs the same way as the other feed tests.
TOKEN=$(cat "$HOME/.orchidlights/api-token" 2>/dev/null || echo "")

node "$HERE/frames-client.mjs" "ws://127.0.0.1:$PORT/ws" "$TOKEN" \
    || fail "the pad did not put the expected values on the universe"

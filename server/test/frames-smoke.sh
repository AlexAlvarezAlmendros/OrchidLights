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
assert len(solo["children"]) == 4, "a frame that reports no children is a frame nobody can see"

# The palettes: a solo frame inside the solo frame, of Override buttons. The
# action has to come back as written, or an editor shows a palette as a toggle
# and the operator finds out on stage.
palettes = widgets[11]
assert palettes["type"] == "soloframe", palettes
assert widgets[12]["action"] == "Override", widgets[12]

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

# ---------------------------------------------------------------------------
# Override: a palette laid over a running look, read from the universe.
#
# Everything above can be true of a button that lights and changes nothing:
# the run state is bookkeeping. What an Override button is FOR is the value
# on the wire -- cyan over red has to come out cyan, where the HTP mix every
# other function gets would come out white. So these press the console the
# way a MIDI wing does and read the universe back.
# ---------------------------------------------------------------------------

BASE="http://127.0.0.1:$PORT/api/v1"
RED_BUTTON=2; BLUE_BUTTON=3; CYAN_PALETTE=12; YELLOW_PALETTE=13
RED=0; CYAN=6; YELLOW=7

press() {
    curl -sf --max-time 5 -X POST "$BASE/vc/widgets/$1/press" \
        -H 'Content-Type: application/json' -d '{}' \
        | python3 -c 'import json,sys; print(json.load(sys.stdin)["state"])'
}

# The first three channels of the universe, as "r,g,b", once they settle on
# what is expected -- or whatever they settled on, so the failure says.
rgb_is() {
    local want=$1 got=""
    for _ in $(seq 1 40); do
        got=$(curl -sf --max-time 5 "$BASE/universes/1/dmx" \
            | python3 -c 'import json,sys; v=json.load(sys.stdin)["values"]; print(",".join(map(str, v[:3])))')
        [ "$got" = "$want" ] && return 0
        sleep 0.05
    done
    echo "universe reads $got, wanted $want" >&2
    return 1
}

# "running/flashing", each a dash when it is not. Off the list: a function is
# not readable on its own, and the list is what the feed broadcasts anyway.
function_state() {
    curl -sf --max-time 5 "$BASE/functions" \
        | python3 -c '
import json, sys
f = next(f for f in json.load(sys.stdin) if f["id"] == '"$1"')
print(("running" if f["running"] else "-") + "/" + ("flashing" if f.get("flashing") else "-"))'
}

[ "$(press $RED_BUTTON)" = "1" ] || fail "pressing the red toggle did not report on"
rgb_is "255,0,0" || fail "red did not reach the universe"

# Cyan over red: replaced, not merged.
[ "$(press $CYAN_PALETTE)" = "1" ] || fail "latching the cyan palette did not report on"
rgb_is "0,255,255" || fail "the palette did not override the look (HTP would have given white)"
[ "$(function_state $RED)" = "running/-" ] || fail "laying a palette stopped the look it was laid over"
[ "$(function_state $CYAN)" = "-/flashing" ] || fail "a latched palette should read as flashing, not running"

# Palettes are exclusive among themselves.
[ "$(press $YELLOW_PALETTE)" = "1" ] || fail "latching the yellow palette did not report on"
rgb_is "255,255,0" || fail "the second palette did not replace the first"
[ "$(function_state $CYAN)" = "-/-" ] || fail "the first palette stayed up under the second"
[ "$(function_state $RED)" = "running/-" ] || fail "the second palette stopped the look"

# A new look comes up in its own colours: the toggle drops the overlay.
[ "$(press $BLUE_BUTTON)" = "1" ] || fail "pressing the blue toggle did not report on"
rgb_is "0,0,255" || fail "blue came up under the old palette"
[ "$(function_state $RED)" = "-/-" ] || fail "the solo frame did not drop red for blue"
[ "$(function_state $YELLOW)" = "-/-" ] || fail "starting a look did not release the palette"

# Press again to release, by hand.
[ "$(press $CYAN_PALETTE)" = "1" ] || fail "re-latching cyan did not report on"
rgb_is "0,255,255" || fail "cyan did not come back over blue"
[ "$(press $CYAN_PALETTE)" = "0" ] || fail "releasing cyan did not report off"
rgb_is "0,0,255" || fail "releasing the palette did not give the look its colours back"

# Stop-all is the panic button, and a palette that survives it recolours
# whatever comes next.
[ "$(press $CYAN_PALETTE)" = "1" ] || fail "latching cyan before stop-all did not report on"
rgb_is "0,255,255" || fail "cyan did not come back before stop-all"
curl -sf --max-time 5 -X POST "$BASE/stop" -H 'Content-Type: application/json' -d '{}' > /dev/null \
    || fail "POST /stop"
rgb_is "0,0,0" || fail "stop-all left something on the universe"
[ "$(function_state $CYAN)" = "-/-" ] || fail "stop-all left the palette latched"

echo "Override palettes: replaced red with cyan, yielded to the next look, and let go on stop-all."

# ---------------------------------------------------------------------------
# A collection drags the solo rule of its members. "Rojo con humo" sits in a
# plain frame and starts red, which sits in the colour bank: blue, up in that
# bank, has to drop, exactly as if red's own button had been pressed.
# ---------------------------------------------------------------------------

LOOK_BUTTON=14; BLUE=1; SMOKE=3

[ "$(press $BLUE_BUTTON)" = "1" ] || fail "pressing the blue toggle did not report on"
rgb_is "0,0,255" || fail "blue did not reach the universe"

[ "$(press $LOOK_BUTTON)" = "1" ] || fail "pressing the look did not report on"
# Red plus smoke, HTP: blue survived would read 255,80,255.
rgb_is "255,80,80" || fail "the look did not bring red and smoke, or blue survived under it"
[ "$(function_state $BLUE)" = "-/-" ] || fail "a collection member in the solo frame did not drop its sibling"
[ "$(function_state $RED)" = "running/-" ] || fail "the collection did not start its member"
[ "$(function_state $SMOKE)" = "running/-" ] || fail "the collection did not start its other member"

# And the bank's own button still drops the member the collection started.
[ "$(press $BLUE_BUTTON)" = "1" ] || fail "pressing blue over the look did not report on"
rgb_is "80,80,255" || fail "blue did not replace the look's red"
[ "$(function_state $RED)" = "-/-" ] || fail "red, started by the collection, survived its sibling"
[ "$(function_state $SMOKE)" = "running/-" ] || fail "the smoke, outside the bank, should have survived"

curl -sf --max-time 5 -X POST "$BASE/stop" -H 'Content-Type: application/json' -d '{}' > /dev/null \
    || fail "POST /stop"
rgb_is "0,0,0" || fail "stop-all left something on the universe"

echo "Collections: a look started red through the bank's solo rule, and the bank's own button dropped it."

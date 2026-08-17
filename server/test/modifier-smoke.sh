#!/bin/bash
#
# Channel modifiers: the curve a channel's values pass through on the way out.
#
#   server/test/modifier-smoke.sh [path-to-orchidlightsd] [path-to-project.qxw]
#
# "Invert" turns a fader upside down; "Always Full" pins a channel open;
# "Exponential Deep" bends a dimmer to match a lamp that does not fade in a
# straight line. It belongs to the patch rather than to any cue.
#
# Modifiers are applied inside the universe, in the same buffer the live feed
# broadcasts, so every assertion here reads DMX back rather than believing the
# model.
#
# Needs Node 22 or newer for its built-in WebSocket.

set -euo pipefail

DAEMON=${1:-orchidlightsd}
PROJECT=${2:-server/test/data/modifiers.qxw}
PORT=${PORT:-9961}
HERE=$(cd "$(dirname "$0")" && pwd)

export QT_QPA_PLATFORM=offscreen

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

# A daemon already on this port would answer every request below, and the test
# would pass or fail against a project nobody chose.
if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/" 2>/dev/null; then
    fail "something is already listening on port $PORT; set PORT= to another one"
fi

# On a copy: this test attaches modifiers and saves, and a test that rewrites a
# file in the repository is a test that only passes once.
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cp "$PROJECT" "$WORK/"
NAME=$(basename "$PROJECT")

"$DAEMON" --port "$PORT" --no-output "$WORK/$NAME" > "$WORK/daemon.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; rm -rf "$WORK"' EXIT

for _ in $(seq 1 100); do
    curl -sf --max-time 1 "http://127.0.0.1:$PORT/api/v1/status" > /dev/null 2>&1 && break
    kill -0 $PID 2>/dev/null || { cat "$WORK/daemon.log" >&2; fail "the daemon exited early"; }
    sleep 0.2
done

TOKEN=$(cat "$HOME/.orchidlights/api-token" 2>/dev/null || echo "")

node "$HERE/modifier-client.mjs" "ws://127.0.0.1:$PORT/ws" "$TOKEN" \
    || fail "a channel modifier did not do what it said"

# And it survives being written out. A modifier that only exists while the
# daemon is up is one the operator loses on the next power cut -- and its
# absence looks like a lamp behaving oddly, not like a setting that went.
curl -sf -X POST "http://127.0.0.1:$PORT/api/v1/project/save" > /dev/null \
    || fail "POST /project/save"

python3 - "$WORK/$NAME" <<'CHECK' || exit 1
import re
import sys

text = open(sys.argv[1]).read()
modifiers = re.findall(r'<Modifier Channel="(\d+)" Name="([^"]*)"/>', text)

# The client leaves exactly one attached: Invert on channel 0, the same one the
# file came with. Everything else it tried was either detached again or refused.
assert modifiers == [('0', 'Invert')], ('wrong modifiers saved', modifiers)

# Inside the Fixture element, which is where QLC+ reads them from. Written
# anywhere else the file still loads and the curves quietly do not apply.
fixture = re.search(r'<Fixture>(?:(?!</Fixture>).)*Barra(?:(?!</Fixture>).)*</Fixture>', text, re.S)
assert fixture is not None, 'the Barra fixture is not in the saved file'
assert '<Modifier Channel="0" Name="Invert"/>' in fixture.group(0), \
    'the modifier was saved outside the fixture it belongs to'
CHECK

echo "Channel modifiers smoke test passed."

#!/bin/bash
#
# The plan: where each fixture stands, and which channels decide its colour.
#
#   server/test/plan-smoke.sh [path-to-orchidlightsd] [path-to-project.qxw]
#
# The colours are worked out in the browser from the DMX frames it already
# receives, so what has to be right here is the map it works from. Each role is
# checked by lighting exactly that channel and reading the wire back.
#
# Needs Node 22 or newer for its built-in WebSocket.

set -euo pipefail

DAEMON=${1:-orchidlightsd}
PROJECT=${2:-server/test/data/plan.qxw}
PORT=${PORT:-9955}
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

# On a copy: this test places fixtures and saves, and a test that rewrites a
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

node "$HERE/plan-client.mjs" "ws://127.0.0.1:$PORT/ws" "$TOKEN" \
    || fail "the plan did not do what it said"

# And it survives being written out, in QLC+'s own shapes: a plan built here
# that the desktop cannot open is a plan trapped in this daemon.
curl -sf -X POST "http://127.0.0.1:$PORT/api/v1/project/save" > /dev/null \
    || fail "POST /project/save"

python3 - "$WORK/$NAME" <<'CHECK' || exit 1
import re
import sys

text = open(sys.argv[1]).read()

monitor = re.search(r'<Monitor[^>]*>(.*?)</Monitor>', text, re.S)
assert monitor is not None, 'the monitor section is not in the saved file'

items = re.findall(r'<FxItem ([^/]*)/>', monitor.group(1))
assert len(items) == 1, ('exactly the one fixture the client left placed', items)

attrs = dict(re.findall(r'(\w+)="([^"]*)"', items[0]))
assert attrs.get('ID') == '2', attrs
assert attrs.get('XPos') == '1200' and attrs.get('YPos') == '800', attrs
assert attrs.get('Rotation') == '45', attrs
assert attrs.get('GelColor') == '#ff8800', attrs

# XPos and YPos, not a third coordinate. This build of the engine writes only
# those two, which is why the API refuses a height instead of losing one.
assert 'ZPos' not in attrs, ('a height was written that will not be read back', attrs)
CHECK

echo "Plan smoke test passed."

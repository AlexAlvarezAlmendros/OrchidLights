#!/bin/bash
#
# The show manager: a multi-track timeline.
#
#   server/test/show-smoke.sh [path-to-orchidlightsd] [path-to-project.qxw]
#
# A timeline is the one thing in a desk where being right in the model and wrong
# in time cannot be told apart from the outside, so the client plays the show and
# reads the wire at 400 ms and at 1200 ms.
#
# Needs Node 22 or newer for its built-in WebSocket.

set -euo pipefail

DAEMON=${1:-orchidlightsd}
PROJECT=${2:-server/test/data/show.qxw}
PORT=${PORT:-9957}
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

# On a copy: this test edits the show and saves, and a test that rewrites a file
# in the repository is a test that only passes once.
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

node "$HERE/show-client.mjs" "ws://127.0.0.1:$PORT/ws" "$TOKEN" \
    || fail "the show manager did not do what it said"

# And it survives being written out, in QLC+'s own shapes: a show built here
# that the desktop cannot open is a show trapped in this daemon.
curl -sf -X POST "http://127.0.0.1:$PORT/api/v1/project/save" > /dev/null \
    || fail "POST /project/save"

python3 - "$WORK/$NAME" <<'CHECK' || exit 1
import re
import sys

text = open(sys.argv[1]).read()

show = re.search(r'<Function ID="\d+" Type="Show"[^>]*>(.*?)</Function>', text, re.S)
assert show is not None, 'the show is not in the saved file'

tracks = re.findall(r'<Track ID="(\d+)" Name="([^"]*)" SceneID="(\d+)"[^>]*>', show.group(1))
assert len(tracks) == 1, ('the track the client added should have been removed again', tracks)
assert tracks[0][1] == 'Luces', tracks[0]

items = re.findall(r'<ShowFunction ID="(\d+)" StartTime="(\d+)" Duration="(\d+)"', show.group(1))
assert items == [('1', '0', '800'), ('2', '800', '800')], ('the timeline did not save as it was', items)
CHECK

echo "Show manager smoke test passed."

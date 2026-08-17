#!/bin/bash
#
# Channels groups: the document's own faders, driven from a browser.
#
#   server/test/channelgroup-smoke.sh [path-to-orchidlightsd] [path-to-project.qxw]
#
# A channels group gathers individual channels -- the dimmer of one lamp, the
# strobe of another -- under one fader. QLC+ keeps them in the Simple Desk,
# which is why they were the last thing in the document with no way in from a
# browser.
#
# The interesting part is not the CRUD but what happens to the light: a channel
# dropped from a group, or a group deleted, is a channel nothing moves any more.
# Every assertion in the client reads DMX back off the wire.
#
# Needs Node 22 or newer for its built-in WebSocket.

set -euo pipefail

DAEMON=${1:-orchidlightsd}
PROJECT=${2:-server/test/data/channel-groups.qxw}
PORT=${PORT:-9970}
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

# On a copy: this test edits groups and saves, and a test that rewrites a file
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

node "$HERE/channelgroup-client.mjs" "ws://127.0.0.1:$PORT/ws" "$TOKEN" \
    || fail "a channels group did not do what it said"

# And it survives being written out. A group that only exists while the daemon
# is up is a group the operator loses on the next power cut.
curl -sf -X POST "http://127.0.0.1:$PORT/api/v1/project/save" > /dev/null \
    || fail "POST /project/save"

python3 - "$WORK/$NAME" <<'PY' || exit 1
import re
import sys

text = open(sys.argv[1]).read()
groups = re.findall(r'<ChannelsGroup ID="(\d+)" Name="([^"]*)"[^>]*>([^<]*)</ChannelsGroup>', text)

by_id = {int(gid): (name, channels) for gid, name, channels in groups}

# Groups 0 and 2 were renamed and had a channel taken out of them; group 1 was
# left as the file had it; the one created and deleted during the run is gone.
assert len(by_id) == 3, ('wrong number of groups saved', by_id)
assert by_id[0] == ('Rojo', '2,0'), ('group 0 did not save as edited', by_id[0])
assert by_id[1] == ('Verde', '2,1'), ('group 1 did not survive untouched', by_id[1])
assert by_id[2] == ('Gobo', '0,4'), ('group 2 did not save as edited', by_id[2])

# The pairs are flattened in QLC+'s own format, which is what makes the file
# readable by QLC+ at all.
for name, channels in by_id.values():
    numbers = channels.split(',')
    assert len(numbers) % 2 == 0, ('a channels list must be fixture,channel pairs', name, channels)
PY

echo "Channels groups smoke test passed."

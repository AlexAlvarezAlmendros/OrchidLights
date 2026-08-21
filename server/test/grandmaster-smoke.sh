#!/bin/bash
#
# The Grand Master and the panic button, read off the frames.
#
#   server/test/grandmaster-smoke.sh [path-to-orchidlightsd]
#
# Also the persistence round trip: modes saved into the console's
# <Properties>, applied by a fresh daemon on the same file -- the half that
# used to be silently wrong, because the section was preserved but never read.

set -euo pipefail

DAEMON=${1:-orchidlightsd}
PORT=${PORT:-9957}
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
PID=""
trap 'kill $PID 2>/dev/null || true; rm -rf "$WORK"' EXIT

# An empty project the test furnishes itself; saved here so the round trip
# has a file to prove things about.
cp "${2:-server/test/data/vc-widgets.qxw}" "$WORK/gm.qxw"

read -r -a EXTRA <<< "${ORCHID_TEST_ARGS:-}"

"$DAEMON" --port "$PORT" --no-output "${EXTRA[@]+"${EXTRA[@]}"}" \
    "$WORK/gm.qxw" > "$WORK/daemon.log" 2>&1 &
PID=$!

for _ in $(seq 1 100); do
    curl -sf --max-time 1 "http://127.0.0.1:$PORT/api/v1/status" > /dev/null 2>&1 && break
    kill -0 $PID 2>/dev/null || { cat "$WORK/daemon.log" >&2; fail "the daemon exited early"; }
    sleep 0.2
done

node "$HERE/grandmaster-client.mjs" "http://127.0.0.1:$PORT" "ws://127.0.0.1:$PORT/ws" \
    || fail "the grand master did not act as claimed"

# Persistence: save with Limit/All, restart, and the fresh daemon must APPLY
# it, not merely carry it.
curl -sf -X PUT -H 'Content-Type: application/json' \
    -d '{"valueMode":"Limit","channelMode":"All","visible":false}' \
    "http://127.0.0.1:$PORT/api/v1/grandmaster" > /dev/null || fail "PUT grandmaster"
curl -sf -X POST "http://127.0.0.1:$PORT/api/v1/project/save" > /dev/null || fail "save"

grep -q '<GrandMaster ChannelMode="All" ValueMode="Limit" Visible="0"/>' "$WORK/gm.qxw" \
    || { grep -o '<GrandMaster[^/]*/>' "$WORK/gm.qxw" >&2; fail "the settings are not in the file"; }

kill -TERM $PID
wait $PID || true

"$DAEMON" --port "$PORT" --no-output "${EXTRA[@]+"${EXTRA[@]}"}" \
    "$WORK/gm.qxw" > "$WORK/daemon2.log" 2>&1 &
PID=$!
for _ in $(seq 1 100); do
    curl -sf --max-time 1 "http://127.0.0.1:$PORT/api/v1/status" > /dev/null 2>&1 && break
    kill -0 $PID 2>/dev/null || { cat "$WORK/daemon2.log" >&2; fail "the second daemon exited early"; }
    sleep 0.2
done

curl -s "http://127.0.0.1:$PORT/api/v1/grandmaster" > "$WORK/gm.json"
python3 - "$WORK/gm.json" <<'CHECK' || fail "the fresh daemon did not apply the saved modes"
import json, sys
body = json.load(open(sys.argv[1]))
assert body["channelMode"] == "All", body
assert body["valueMode"] == "Limit", body
assert body["visible"] is False, body
# The VALUE deliberately resets: a desk that comes up half-dimmed because of
# last night is a desk somebody debugs in the dark.
assert body["value"] == 255, body
CHECK

echo "Grand master smoke test passed."

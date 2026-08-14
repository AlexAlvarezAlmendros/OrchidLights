#!/bin/bash
#
# What an edit to the console does to the submasters holding a look.
#
#   server/test/submaster-smoke.sh [path-to-orchidlightsd] [path-to-project.qxw]
#
# Editing the Virtual Console makes the daemon re-read it and re-register
# everything. Both the value a submaster is holding and its claim on its channels
# have to survive that -- and neither did: every edit stranded a submaster that
# carried on asserting its last value, so the slider could never bring the
# channel back down.
#
# Needs Node 22 or newer for its built-in WebSocket.

set -euo pipefail

DAEMON=${1:-orchidlightsd}
PROJECT=${2:-server/test/data/vc-submaster.qxw}
PORT=${PORT:-9978}
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

# On a copy: this test edits the console, and a test that rewrites a file in
# the repository is a test that only passes once.
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cp "$PROJECT" "$WORK/"

"$DAEMON" --port "$PORT" --no-output "$WORK/$(basename "$PROJECT")" > /tmp/orchid-submaster.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; rm -rf "$WORK"' EXIT

for _ in $(seq 1 100); do
    curl -sf --max-time 1 "http://127.0.0.1:$PORT/api/v1/status" > /dev/null 2>&1 && break
    kill -0 $PID 2>/dev/null || { cat /tmp/orchid-submaster.log >&2; fail "the daemon exited early"; }
    sleep 0.2
done


# Loopback with no --require-auth needs no token, but pass one when there is a
# file, so this runs the same way as the other feed tests.
TOKEN=$(cat "$HOME/.orchidlights/api-token" 2>/dev/null || echo "")

node "$HERE/submaster-client.mjs" "ws://127.0.0.1:$PORT/ws" "$TOKEN" \
    || fail "a submaster did not scale what it should, or scaled what it should not"

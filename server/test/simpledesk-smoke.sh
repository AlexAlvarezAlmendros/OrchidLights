#!/bin/bash
#
# The Simple Desk: raw universe channels, held by hand.
#
#   server/test/simpledesk-smoke.sh [path-to-orchidlightsd]
#
# Everything is read off the frames: the keypad grammar, the bare-wire
# channels no fixture owns (the difference between this desk and /live), the
# override that beats a running function, and the releases.

set -euo pipefail

DAEMON=${1:-orchidlightsd}
PORT=${PORT:-9953}
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

"$DAEMON" --port "$PORT" --no-output "${EXTRA[@]+"${EXTRA[@]}"}" > "$WORK/daemon.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; rm -rf "$WORK"' EXIT

for _ in $(seq 1 100); do
    curl -sf --max-time 1 "http://127.0.0.1:$PORT/api/v1/status" > /dev/null 2>&1 && break
    kill -0 $PID 2>/dev/null || { cat "$WORK/daemon.log" >&2; fail "the daemon exited early"; }
    sleep 0.2
done

node "$HERE/simpledesk-client.mjs" "http://127.0.0.1:$PORT" "ws://127.0.0.1:$PORT/ws" \
    || fail "the desk did not do what it says"

echo "Simple desk smoke test passed."

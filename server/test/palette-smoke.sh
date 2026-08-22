#!/bin/bash
#
# Palettes: one value with a name, referenced from scenes.
#
#   server/test/palette-smoke.sh [path-to-orchidlightsd]
#
# The promise under test is the indirection: retint the palette and the
# scene's next run retints WITHOUT the scene changing; fan it Linear over
# four bars laid left to right and the wire reads monotonic.

set -euo pipefail

DAEMON=${1:-orchidlightsd}
PORT=${PORT:-9937}
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

"$DAEMON" --port "$PORT" --no-output --projects "$WORK" "${EXTRA[@]+"${EXTRA[@]}"}" > "$WORK/daemon.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; rm -rf "$WORK"' EXIT

for _ in $(seq 1 100); do
    curl -sf --max-time 1 "http://127.0.0.1:$PORT/api/v1/status" > /dev/null 2>&1 && break
    kill -0 $PID 2>/dev/null || { cat "$WORK/daemon.log" >&2; fail "the daemon exited early"; }
    sleep 0.2
done

node "$HERE/palette-client.mjs" "http://127.0.0.1:$PORT" "ws://127.0.0.1:$PORT/ws" \
    "$WORK/paletas.qxw" || fail "the palettes did not do what they say"

echo "Palette smoke test passed."

#!/bin/bash
#
# The matrix editor's promises, read off the wire and out of the file.
#
#   server/test/rgbmatrix-smoke.sh [path-to-orchidlightsd]
#
# Blend and control mode are MEASURED (Mask over darkness is darkness; White
# control moves the white channel and leaves RGB alone); the five colours of
# a script survive into body and .qxw; a script's dynamic property lands as
# <Property>; text and image algorithms carry their settings; and the bake
# produces a sequence whose steps hold the pixels the algorithm painted.

set -euo pipefail

DAEMON=${1:-orchidlightsd}
PORT=${PORT:-9941}
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

"$DAEMON" --port "$PORT" --no-output --projects "$WORK" \
    "${EXTRA[@]+"${EXTRA[@]}"}" > "$WORK/daemon.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; rm -rf "$WORK"' EXIT

for _ in $(seq 1 100); do
    curl -sf --max-time 1 "http://127.0.0.1:$PORT/api/v1/status" > /dev/null 2>&1 && break
    kill -0 $PID 2>/dev/null || { cat "$WORK/daemon.log" >&2; fail "the daemon exited early"; }
    sleep 0.2
done

node "$HERE/rgbmatrix-client.mjs" "http://127.0.0.1:$PORT" "ws://127.0.0.1:$PORT/ws" \
    "$WORK/matriz.qxw" || fail "the matrix did not do what it says"

echo "RGB matrix smoke test passed."

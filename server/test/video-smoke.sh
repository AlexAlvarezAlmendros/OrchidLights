#!/bin/bash
#
# F21's video: the daemon directs, any browser projects.
#
#   server/test/video-smoke.sh [path-to-orchidlightsd]
#
# Runs WITH --require-auth on purpose: the media route's whole promise is
# that a bare TV taped behind the stage plays WITHOUT a token while every
# other route demands one.

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
read -r -a EXTRA <<< "${ORCHID_TEST_ARGS:-}"

python3 - "$WORK/pelicula.wav" <<'MAKE'
import math
import struct
import sys
import wave

with wave.open(sys.argv[1], 'w') as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(8000)
    for i in range(8000 * 30):
        w.writeframes(struct.pack('<h', int(8000 * math.sin(i * 0.2))))
MAKE

"$DAEMON" --port "$PORT" --no-output --require-auth --projects "$WORK" \
    "${EXTRA[@]+"${EXTRA[@]}"}" > "$WORK/daemon.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; rm -rf "$WORK"' EXIT

for _ in $(seq 1 100); do
    STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 "http://127.0.0.1:$PORT/api/v1/status" 2>/dev/null || true)
    { [ "$STATUS" = 200 ] || [ "$STATUS" = 401 ]; } && break
    kill -0 $PID 2>/dev/null || { cat "$WORK/daemon.log" >&2; fail "the daemon exited early"; }
    sleep 0.2
done

node "$HERE/video-client.mjs" "http://127.0.0.1:$PORT" "ws://127.0.0.1:$PORT/ws" \
    "$WORK/pelicula.wav" || fail "the video did not do what it says"

echo "Video smoke test passed."

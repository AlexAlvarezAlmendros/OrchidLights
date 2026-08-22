#!/bin/bash
#
# F15b's rig tools: the RGB panel wizard, the remap that carries the show
# across, linked lamps, and selective import from another project.
#
#   server/test/rigtools-smoke.sh [path-to-orchidlightsd]
#
# The remap is proven ON THE WIRE: a scene lit before the swap must light the
# NEW address after it, through channels matched semantically. The panel and
# the import are proven in the .qxw.

set -euo pipefail

DAEMON=${1:-orchidlightsd}
PORT=${PORT:-9947}
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

node "$HERE/rigtools-client.mjs" "http://127.0.0.1:$PORT" "ws://127.0.0.1:$PORT/ws" "$WORK" \
    || fail "the rig tools did not do what they say"

echo "Rig tools smoke test passed."
